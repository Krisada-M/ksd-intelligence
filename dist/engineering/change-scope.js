import { realpathSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";

/**
 * Parse zero-context Git patches. Added lines only; deletion-only hunks are not enforceable.
 * Only the standard two-parent `a/`/`b/` unified format produced with `-U0` is accepted;
 * anything else (custom prefixes, combined diffs, context-bearing hunks) is rejected.
 */
const POSIX = process.platform !== "win32";
const MAX_HUNK_LINES = 100_000;

const SIMPLE_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 0x5c, '"': 0x22 };
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Decode one c-quoted Git path label (opening quote included) to a POSIX-ish string. */
function decodeQuotedLabel(label) {
  const bytes = [];
  let i = 1;
  while (i < label.length) {
    const ch = label.charAt(i);
    if (ch === '"') {
      return finishQuotedLabel(bytes);
    }
    if (ch !== "\\") {
      const code = label.codePointAt(i);
      if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) throw new Error("Git path label is not properly quoted");
      const character = String.fromCodePoint(code);
      bytes.push(...Buffer.from(character, "utf8"));
      i += character.length;
      continue;
    }
    i += 1;
    const esc = label.charAt(i);
    if (esc === "") throw new Error("Git path label is not properly quoted");
    if (esc >= "0" && esc <= "7") {
      let value = 0;
      for (let n = 0; n < 3; n++) {
        const digit = label.charAt(i);
        if (digit < "0" || digit > "7") break;
        value = value * 8 + (digit.charCodeAt(0) - 0x30);
        i += 1;
      }
      if (value > 0xff) throw new Error("Git path label is not properly quoted");
      bytes.push(value);
      continue;
    }
    const simple = SIMPLE_ESCAPES[esc];
    if (simple === undefined) throw new Error("Git path label is not properly quoted");
    bytes.push(simple);
    i += 1;
  }
  throw new Error("Git path label is not properly quoted");
}

function finishQuotedLabel(bytes) {
  // Decode the combined literal and escaped bytes strictly so invalid UTF-8 is rejected.
  const text = decoder.decode(Uint8Array.from(bytes));

  if (text.includes("\u0000")) throw new Error("Git path contains NUL bytes");

  return text;
}

/** Slice the next space-delimited or quoted label token from the start of `text`. */
function nextLabel(text) {
  if (text.startsWith('"')) {
    let i = 1;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === '"') return { raw: text.slice(0, i + 1), rest: text.slice(i + 1) };
      i += 1;
    }
    throw new Error("Git path label is not properly quoted");
  }
  const end = text.indexOf(" ");

  if (end === -1) return { raw: text, rest: "" };

  return { raw: text.slice(0, end), rest: text.slice(end) };
}

/** Validate the `diff --git a/… b/…` header; nonstandard prefixes/variants are rejected here. */
function requireDiffGitLabels(line) {
  const body = line.slice("diff --git ".length);
  const candidates = [];
  const add = (oldLabel, rawNew) => {
    let newLabel = rawNew;
    if (rawNew.startsWith('"')) {
      const token = nextLabel(rawNew);
      if (token.rest !== "") throw new Error("Git diff --git header needs exactly two path labels");
      newLabel = decodeQuotedLabel(token.raw);
    }
    if (oldLabel.startsWith("a/") && newLabel.startsWith("b/")) candidates.push({ oldLabel, newLabel });
  };
  if (body.startsWith('"')) {
    const first = nextLabel(body);
    if (!first.rest.startsWith(" ")) throw new Error("Git diff --git header needs two path labels");
    add(decodeQuotedLabel(first.raw), first.rest.slice(1));
  } else {
    for (let boundary = body.indexOf(" "); boundary !== -1; boundary = body.indexOf(" ", boundary + 1)) {
      const remainder = body.slice(boundary + 1);
      if (remainder.startsWith("b/") || remainder.startsWith('"b/')) {
        add(body.slice(0, boundary), remainder);
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error("Malformed or unsupported Git diff --git header; regenerate with -U0 and default a/ b/ prefixes");
  }

  return candidates;
}

/** Parse the label on a `---`/`+++` section line. The delimiter is the marker space itself. */
function sectionLabel(line) {
  const body = line.slice(4);
  if (body === "" ) throw new Error("Malformed Git diff path label");
  if (body.startsWith('"')) {
    const token = nextLabel(body);
    if (token.rest !== "" && token.rest !== "\t") throw new Error("Malformed Git diff path label");

    return decodeQuotedLabel(token.raw);
  }
  // Git closes an unquoted label that contains spaces/tabs with an appended TAB delimiter.
  // The tab is the delimiter, not filename content, so exactly one is stripped.
  const label = body.endsWith("\t") ? body.slice(0, -1) : body;

  if (label === "" ) throw new Error("Malformed Git diff path label");

  return label;
}

/** Validate a `+++` destination: must be a relative repository path (or /dev/null). */
function destinationPath(label) {
  if (label === "/dev/null") return null; // deleted file; it can never gain added lines
  if (!label.startsWith("b/")) throw new Error("Unsupported Git diff destination prefix; regenerate with -U0");

  const rel = POSIX ? label.slice(2) : label.slice(2).replaceAll("\\", "/");
  if (rel === "" ) throw new Error("Git diff destination path is empty");
  if (rel === "/" || rel.startsWith("/") || (POSIX ? /^[A-Za-z]:[\\/]/ : /^[A-Za-z]:/).test(rel) || rel.startsWith("\\\\")) {
    throw new Error("Git diff destination must be a relative repository path");
  }
  const normalized = POSIX ? normalize(rel) : normalize(rel).replaceAll("\\", "/");

  if (normalized === ".." || normalized.startsWith("../")) throw new Error("Diff path escapes repository");

  return normalized;
}

function setDestination(files, dest) {
  if (dest !== null && !files.has(dest)) files.set(dest, new Set());
}

export function parseChangedLines(patch) {
  if (typeof patch !== "string") throw new TypeError("Git diff must be text");
  if (patch.includes("\u0000")) throw new Error("Git diff contains NUL bytes");

  const files = new Map();
  const lines = patch.split(/\r?\n/);
  let dest = undefined; // selected destination: string key, null (/dev/null), or undefined (none yet)
  let sawFileHeader = false;
  let sawOldLabel = false;
  let sawNewLabel = false;
  let sawHunk = false;
  let labels;
  let metadata;
  let oldLeft = 0;
  let newLeft = 0;
  let lineNumber = 0;
  let oldEnd;
  let newEnd;

  function narrowLabels(predicate, message) {
    labels = labels.filter(predicate);
    if (labels.length === 0) throw new Error(message);
  }

  function finishSection() {
    if (!labels) return;
    if (labels.length > 1 && !metadata.renameTo && !metadata.copyTo) {
      const samePath = labels.filter(({ oldLabel, newLabel }) => oldLabel.slice(2) === newLabel.slice(2));
      if (samePath.length === 1) labels = samePath;
    }
    if (labels.length !== 1) throw new Error("Ambiguous Git diff path labels");
    destinationPath(`b/${labels[0].oldLabel.slice(2)}`);
    destinationPath(labels[0].newLabel);
    if (sawOldLabel !== sawNewLabel) throw new Error("Incomplete Git diff file header");
    if (metadata.renameFrom !== metadata.renameTo || metadata.copyFrom !== metadata.copyTo ||
        metadata.oldMode !== metadata.newMode) {
      throw new Error("Incomplete Git diff metadata");
    }
    if ((metadata.newFile && (metadata.deletedFile || metadata.renameTo || metadata.copyTo)) ||
        (metadata.deletedFile && (metadata.renameTo || metadata.copyTo)) ||
        (metadata.renameTo && metadata.copyTo)) {
      throw new Error("Conflicting Git diff metadata");
    }
    if (sawNewLabel && !sawHunk) throw new Error("Git diff file headers require a hunk");
    if (!sawHunk && !metadata.binary && !metadata.renameTo && !metadata.copyTo &&
        !metadata.newMode && !metadata.newFile && !metadata.deletedFile) {
      throw new Error("Incomplete Git diff section");
    }
  }

  for (const [index, line] of lines.entries()) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a declared hunk body: declared counts must be consumed before any header.
      if (line === "\\ No newline at end of file") continue;
      if (line.startsWith("+")) {
        if (newLeft <= 0) throw new Error("Malformed Git diff hunk: too many added lines");
        if (dest === null) throw new Error("Deletion-only hunks cannot contain added lines");
        if (!Number.isSafeInteger(lineNumber)) throw new Error("Git diff hunk line number exceeds safe integers");
        files.get(dest).add(lineNumber);
        lineNumber += 1;
        newLeft -= 1;
        continue;
      }
      if (line.startsWith("-")) {
        if (oldLeft <= 0) throw new Error("Malformed Git diff hunk: too many removed lines");
        oldLeft -= 1;
        continue;
      }
      if (line.startsWith(" ")) {
        throw new Error("Git diff hunks must not contain context lines; regenerate with -U0");
      }
      throw new Error("Git diff hunk is truncated or malformed");
    }

    if (line.startsWith("diff --git ")) {
      finishSection();
      labels = requireDiffGitLabels(line);
      metadata = {};
      sawFileHeader = true;
      dest = undefined;
      sawOldLabel = false;
      sawNewLabel = false;
      sawHunk = false;
      oldEnd = undefined;
      newEnd = undefined;
      continue;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      throw new Error("Combined Git diffs are not supported");
    }
    if (line.startsWith("diff ")) throw new Error("Unsupported Git diff header");
    if (line.startsWith("--- ")) {
      if (sawOldLabel || sawNewLabel || sawHunk) throw new Error("Malformed Git diff file header");
      if (!labels) throw new Error("Git diff file header has no diff --git header");
      const oldLabel = sectionLabel(line);
      narrowLabels(({ oldLabel: oldPath, newLabel: newPath }) =>
        oldLabel === oldPath || (oldLabel === "/dev/null" && oldPath.slice(2) === newPath.slice(2)),
      "Git diff old path label does not match header");
      if (metadata.newFile && oldLabel !== "/dev/null") throw new Error("Invalid Git diff new file header");
      metadata.oldNull = oldLabel === "/dev/null";
      sawOldLabel = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!labels || !sawOldLabel || sawNewLabel || sawHunk) throw new Error("Malformed Git diff file header");
      const newLabel = sectionLabel(line);
      dest = destinationPath(newLabel);
      narrowLabels(({ oldLabel: oldPath, newLabel: newPath }) =>
        newLabel === newPath || (newLabel === "/dev/null" && !metadata.oldNull && oldPath.slice(2) === newPath.slice(2)),
      "Git diff destination path label does not match header");
      if (metadata.deletedFile && newLabel !== "/dev/null") throw new Error("Invalid Git diff deleted file header");
      sawNewLabel = true;
      setDestination(files, dest);
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!sawOldLabel || !sawNewLabel) throw new Error("Git diff hunk requires file headers");
      sawHunk = true;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error("Malformed Git diff hunk header");
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) {
        throw new Error("Invalid Git diff hunk counts");
      }
      if (oldCount > MAX_HUNK_LINES || newCount > MAX_HUNK_LINES) {
        throw new Error("Invalid or excessively large Git diff hunk");
      }
      if (!Number.isSafeInteger(oldStart + oldCount) || !Number.isSafeInteger(newStart + newCount)) {
        throw new Error("Git diff hunk exclusive end exceeds safe integers");
      }
      if (dest === undefined) throw new Error("Git diff hunk appears before a destination path");
      if (metadata.oldNull && oldCount > 0) throw new Error("New file hunks cannot contain removed lines");
      if (oldCount === 0 && newCount === 0) throw new Error("Empty Git diff hunk");
      if ((oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) {
        throw new Error("Invalid Git diff hunk start");
      }
      const oldOffset = oldStart - (oldCount > 0 ? 1 : 0);
      const newOffset = newStart - (newCount > 0 ? 1 : 0);
      if (oldEnd !== undefined && (oldOffset < oldEnd || newOffset < newEnd)) {
        throw new Error("Overlapping or out-of-order Git diff hunks");
      }
      if (oldOffset - (oldEnd ?? 0) !== newOffset - (newEnd ?? 0)) {
        throw new Error("Inconsistent unchanged lines between Git diff hunks");
      }
      oldEnd = oldOffset + oldCount;
      newEnd = newOffset + newCount;
      if (dest === null && newCount > 0) throw new Error("Deletion-only hunks cannot contain added lines");
      oldLeft = oldCount;
      newLeft = newCount;
      lineNumber = newStart;
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) throw new Error("Malformed Git diff hunk body");
    if (line === "" && index === lines.length - 1) continue;
    if (line === "\\ No newline at end of file" && sawHunk) continue;
    if (!labels) throw new Error("Not a recognizable Git patch");
    if (sawOldLabel || sawNewLabel || sawHunk || metadata.binary) {
      throw new Error("Malformed Git diff section");
    }
    let key;
    let match;
    if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/i.test(line)) key = "index";
    else if (/^similarity index (?:100|[0-9]{1,2})%$/.test(line)) key = "similarity";
    else if (/^dissimilarity index (?:100|[0-9]{1,2})%$/.test(line)) key = "dissimilarity";
    else if ((match = /^(old mode|new mode|new file mode|deleted file mode) ([0-7]{6})$/.exec(line))) {
      key = { "old mode": "oldMode", "new mode": "newMode", "new file mode": "newFile", "deleted file mode": "deletedFile" }[match[1]];
    } else if ((match = /^(rename from|rename to|copy from|copy to) (.+)$/.exec(line))) {
      key = { "rename from": "renameFrom", "rename to": "renameTo", "copy from": "copyFrom", "copy to": "copyTo" }[match[1]];
      const path = sectionLabel(`--- ${match[2]}`);
      narrowLabels(({ oldLabel, newLabel }) => path === (key.endsWith("From") ? oldLabel.slice(2) : newLabel.slice(2)),
        "Git diff metadata path does not match header");
    } else if (/^Binary files .+ and .+ differ$/.test(line)) key = "binary";
    else throw new Error("Malformed or unsupported Git diff metadata");
    if (metadata[key]) throw new Error("Duplicate Git diff metadata");
    metadata[key] = true;
  }

  if (oldLeft > 0 || newLeft > 0) throw new Error("Git diff hunk is truncated or malformed");
  finishSection();
  if (files.size === 0 && !sawFileHeader && patch.trim() !== "") {
    throw new Error("Not a recognizable Git patch");

  }

  return files;
}

/** Resolve symlinks via the nearest existing ancestor; ESLint may report paths that no longer exist. */
function canonical(path) {
  const missing = [];
  let current = resolve(path);
  while (true) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      // Not on disk (yet): resolve the parent instead.
    }

    const parent = dirname(current);
    if (parent === current) return resolve(path);

    missing.unshift(basename(current));
    current = parent;
  }
}

function reportPath(filename, realCwd) {
  if (typeof filename !== "string" || filename.length === 0) return null;

  return canonical(resolve(realCwd, filename));
}

function validateEslintReport(eslintReport) {
  if (!Array.isArray(eslintReport)) throw new TypeError("Expected ESLint JSON array");
  for (const entry of eslintReport) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Each ESLint report entry must be an object");
    }
    if (typeof entry.filePath !== "string") {
      throw new TypeError("Each ESLint report entry needs a filePath string");
    }
    if (!Array.isArray(entry.messages)) {
      throw new TypeError("Each ESLint report entry needs a messages array");
    }
    let errors = 0;
    let warnings = 0;
    let fatals = 0;
    for (const message of entry.messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new TypeError("Each ESLint diagnostic must be an object");
      }
      if (message.severity !== 1 && message.severity !== 2) {
        throw new TypeError("ESLint diagnostic severity must be 1 or 2");
      }
      if (message.severity === 2) errors += 1;
      else warnings += 1;
      if (message.fatal !== undefined && typeof message.fatal !== "boolean") {
        throw new TypeError("ESLint diagnostic fatal flag must be boolean");
      }
      if (message.fatal === true) fatals += 1;
      if (message.line !== undefined && !(Number.isSafeInteger(message.line) && message.line > 0)) {
        throw new TypeError("ESLint diagnostic line must be a positive integer or absent");
      }
      if (message.ruleId !== undefined && message.ruleId !== null && typeof message.ruleId !== "string") {
        throw new TypeError("ESLint diagnostic ruleId must be a string or null");
      }
    }
    // Only count keys actually present are validated, but a contradiction is caller error.
    if (entry.errorCount !== undefined && entry.errorCount !== errors) {
      throw new TypeError("ESLint report errorCount contradicts the supplied messages");
    }
    if (entry.warningCount !== undefined && entry.warningCount !== warnings) {
      throw new TypeError("ESLint report warningCount contradicts the supplied messages");
    }
    if (entry.fatalErrorCount !== undefined && entry.fatalErrorCount !== fatals) {
      throw new TypeError("ESLint report fatalErrorCount contradicts the supplied messages");
    }
  }
}

/**
 * Restrict diagnostics from a real ESLint JSON report to changed source lines.
 * The neighboring line is included for boundary spacing (new helper before old helper).
 * A clean report does NOT prove that the required plugin rules were configured, and a
 * locationless nonfatal warning (e.g. an ignored file) does NOT prove the file was linted.
 */
export function inspectChangedScope(patch, eslintReport, { cwd = process.cwd() } = {}) {
  // Input validation precedes scope decisions: a malformed report must never turn into NOT_APPLICABLE.
  validateEslintReport(eslintReport);

  const changes = parseChangedLines(patch);
  const sourceFiles = [...changes.keys()].filter(name => /\.[cm]?[jt]sx?$/.test(name) && changes.get(name).size > 0);

  const reports = new Map();
  const realCwd = canonical(cwd);
  for (const entry of eslintReport) {
    const key = reportPath(entry.filePath, realCwd);
    if (!key) continue;
    if (reports.has(key)) throw new Error(`Duplicate ESLint report for ${key}`);
    reports.set(key, entry.messages);
  }
  if (sourceFiles.length === 0) {
    return { status: "NOT_APPLICABLE", checkedFiles: [], missingFiles: [], diagnostics: [] };
  }

  const missingFiles = [];
  const diagnostics = [];

  for (const file of sourceFiles) {
    const changed = changes.get(file);
    const messages = reports.get(reportPath(file, realCwd));
    if (!messages) {
      missingFiles.push(file);
      continue;
    }

    let hasLocationlessWarning = false;

    for (const issue of messages) {
      const lineno = issue.line;
      if (Number.isSafeInteger(lineno)) {
        if (issue.fatal === true || changed.has(lineno) || changed.has(lineno - 1)) {
          diagnostics.push(diagnostic(file, lineno, issue));
        }
        continue;
      }
      // Locationless: fatal errors and other errors are file-wide; warnings are not evidence.
      if (issue.severity === 2 || issue.fatal === true) {
        diagnostics.push({ ...diagnostic(file, null, issue), severity: "error" });
        continue;
      }
      hasLocationlessWarning = true;
      diagnostics.push({ ...diagnostic(file, null, issue), severity: "warning" });
    }

    if (hasLocationlessWarning) missingFiles.push(file);
  }

  const status = missingFiles.length > 0
    ? "NOT_RUN"
    : diagnostics.some(d => d.severity === "error")
      ? "FIX_REQUIRED"
      : diagnostics.length > 0
        ? "WARN"
        : "PASS";

  return {
    status,
    checkedFiles: sourceFiles.filter(file => reports.has(reportPath(file, realCwd))),
    missingFiles,
    diagnostics,
    limitation: "PASS only means no changed-line diagnostics in the supplied ESLint JSON; ESLint rule configuration and CI execution are not independently verified.",
  };
}

function diagnostic(file, line, issue) {
  return {
    file,
    line,
    ruleId: issue.ruleId ?? null,
    severity: issue.severity === 2 || issue.fatal ? "error" : "warning",
    message: String(issue.message ?? "Unspecified diagnostic"),
  };
}

#!/bin/bash
# M1b Part B remaining measurement queue. Each step solo (previous finished), node and bun interleaved.
# Usage: bash spikes/m1b/run-queue.sh   (raw outputs land in spikes/m1b/out/, logs appended to out/run-queue.log)
set -u
cd "$(dirname "$0")/../.."
OUT=spikes/m1b/out
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/run-queue.log"; }

log "b4 pick (node)"
node --max-old-space-size=6144 spikes/m1b/b4-builder.cjs pick >>"$OUT/run-queue.log" 2>&1 || log "b4 pick FAILED"

log "b4 rounds affected (node)"
node --max-old-space-size=6144 spikes/m1b/b4-builder.cjs rounds --chain=affected --out=b4-affected-node.json >/dev/null 2>&1 || log "b4 affected node FAILED"

log "b4 rounds affected (bun)"
bun spikes/m1b/b4-builder.cjs rounds --chain=affected --out=b4-affected-bun.json >/dev/null 2>&1 || log "b4 affected bun FAILED"

log "b4 rounds check (node)"
node --max-old-space-size=6144 spikes/m1b/b4-builder.cjs rounds --chain=check --out=b4-check-node.json >/dev/null 2>&1 || log "b4 check node FAILED"

log "b2 seq reachable (node)"
node --max-old-space-size=6144 spikes/m1b/b2-cost.cjs seq reachable --out=b2-seq-reachable-node.json >/dev/null 2>&1 || log "seq node FAILED"

log "b2 seq reachable (bun)"
bun spikes/m1b/b2-cost.cjs seq reachable --out=b2-seq-reachable-bun.json >/dev/null 2>&1 || log "seq bun FAILED"

log "b3 worker cap 1536 (node)"
node spikes/m1b/b3-worker.cjs 1536 reachable >/dev/null 2>&1 || log "b3 1536 node nonzero exit"

log "b3 worker cap 4608 (node)"
node spikes/m1b/b3-worker.cjs 4608 reachable >/dev/null 2>&1 || log "b3 4608 node nonzero exit"

log "b3 worker cap 1536 (bun)"
bun spikes/m1b/b3-worker.cjs 1536 reachable >/dev/null 2>&1 || log "b3 1536 bun nonzero exit"

log "b2 packages seq (node)"
node --max-old-space-size=6144 spikes/m1b/b2-cost.cjs seq packages --out=b2-seq-packages-node.json >/dev/null 2>&1 || log "packages node FAILED"

log "b5 write (node)"
node --max-old-space-size=6144 spikes/m1b/b5-buildinfo.cjs write >>"$OUT/run-queue.log" 2>&1 || log "b5 write node FAILED"

log "b5 read body (node)"
node --max-old-space-size=6144 spikes/m1b/b5-buildinfo.cjs read --edit=body >>"$OUT/run-queue.log" 2>&1 || log "b5 read node FAILED"

log "b4 rounds check (bun)"
bun spikes/m1b/b4-builder.cjs rounds --chain=check --out=b4-check-bun.json >/dev/null 2>&1 || log "b4 check bun FAILED"

log "b2 packages seq (bun)"
bun spikes/m1b/b2-cost.cjs seq packages --out=b2-seq-packages-bun.json >/dev/null 2>&1 || log "packages bun FAILED"

log "b5 write+read (bun)"
bun spikes/m1b/b5-buildinfo.cjs write >>"$OUT/run-queue.log" 2>&1 || log "b5 write bun FAILED"
bun spikes/m1b/b5-buildinfo.cjs read --edit=body >>"$OUT/run-queue.log" 2>&1 || log "b5 read bun FAILED"

log "queue done"

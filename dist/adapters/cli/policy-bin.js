import { fileURLToPath } from 'node:url';
export async function runPolicyBin(entry, usage) {
    if (process.argv.length === 3 && process.argv[2] === '--help') {
        console.log(`Usage: ${usage}`);
        return;
    }
    // The frozen bin runs only when argv[1] resolves to its own module.
    process.argv[1] = fileURLToPath(entry);
    await import(entry.href);
}

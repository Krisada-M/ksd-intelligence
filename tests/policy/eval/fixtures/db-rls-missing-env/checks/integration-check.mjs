// Integration entry point. Exits 0 while reporting on stdout that it executed
// NO tests and skipped ZERO, because TEST_DATABASE_URL is absent.
// This fixture intentionally ships no database and no credentials, so the
// console output is the honest boundary: exit code 0 here is NOT test success.
if (!process.env.TEST_DATABASE_URL) {
    console.log("db-rls integration suite: 0 tests executed, 0 passed, 0 failed, 0 skipped");
    console.log("TEST_DATABASE_URL is absent; no database integration was performed");
    process.exit(0);
}

// Unreachable in the pilot (no credentials are shipped); refuse loudly anyway.
console.error("TEST_DATABASE_URL is set; this fixture ships no database or credentials");
process.exit(2);

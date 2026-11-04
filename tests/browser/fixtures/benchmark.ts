import "./app.ts";
// Admit benchmark imports before sampling. The functions still own their unchanged internal timers.
import "../../../bench/browser/fixture.ts";

/** The benchmark document completes module acquisition without executing a storage workload. */
Object.assign(window, { opfsBenchmarkReady: true });

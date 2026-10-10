import { startDaemon } from "./adapter/daemon.js";

export { startDaemon };

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("MPAS Credential Adapter daemon placeholder");
}

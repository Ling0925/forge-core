import { fileLock } from "../../dist/store/lock.js";
await fileLock(process.argv[2]);
process.stdout.write("ready\n");
setInterval(() => {}, 1000);

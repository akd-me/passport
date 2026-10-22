// The renderer is the unchanged web UI and needs no Node or IPC access. This only lets the UI
// tell that it runs inside the Mac app, should it ever want to adjust copy.
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("passportDesktop", Object.freeze({ platform: process.platform }));

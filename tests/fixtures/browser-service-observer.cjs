// Observe the real Electron profile API while executing the production entry.
// No replacement Electron, windows, CDP, or filesystem behavior.
const { app } = require("electron");
const setPath = app.setPath.bind(app);
app.setPath = (name, value) => {
	setPath(name, value);
	if (["userData", "sessionData"].includes(name)) process.send({ kind: "profile-path", name, value: app.getPath(name), ready: app.isReady() });
};
require("../../electron/main.cjs");

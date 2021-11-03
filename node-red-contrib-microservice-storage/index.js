const fs = require("fs-extra");
const fsPath = require("path");
const log = require("@node-red/util").log; // TODO: separate module

const util = require("@node-red/runtime/lib/storage/localfilesystem/util");
const runtimeSettings = require("@node-red/runtime/lib/storage/localfilesystem/settings");
const sessions = require("@node-red/runtime/lib/storage/localfilesystem/sessions");
const library = require("@node-red/runtime/lib/storage/localfilesystem/library");
const projects = require("@node-red/runtime/lib/storage/localfilesystem/projects");

const saveFlowAndMicroServices = require("./saveFlowAndMicroServices");

const initialFlowLoadComplete = false;
var settings;

function checkForConfigFile(dir) {
  return (
    fs.existsSync(fspath.join(dir, ".config.json")) ||
    fs.existsSync(fspath.join(dir, ".config.nodes.json"))
  );
}

const microserviceStorageModuleInterface = {
  init: async function (_settings, runtime) {
    settings = _settings;

    if (!settings.userDir) {
      if (checkForConfigFile(process.env.NODE_RED_HOME)) {
        settings.userDir = process.env.NODE_RED_HOME;
      } else if (
        process.env.HOMEPATH &&
        checkForConfigFile(fsPath.join(process.env.HOMEPATH, ".node-red"))
      ) {
        settings.userDir = fsPath.join(process.env.HOMEPATH, ".node-red");
      } else {
        settings.userDir = fsPath.join(
          process.env.HOME ||
            process.env.USERPROFILE ||
            process.env.HOMEPATH ||
            process.env.NODE_RED_HOME,
          ".node-red"
        );
      }
    }
    if (!settings.readOnly) {
      await fs.ensureDir(fsPath.join(settings.userDir, "node_modules"));
    }
    sessions.init(settings);
    await runtimeSettings.init(settings);
    await library.init(settings);
    await projects.init(settings, runtime);

    var packageFile = fsPath.join(settings.userDir, "package.json");

    if (!settings.readOnly) {
      try {
        fs.statSync(packageFile);
      } catch (err) {
        var defaultPackage = {
          name: "node-red-project",
          description: "A Node-RED Project",
          version: "0.0.1",
          private: true,
        };
        return util.writeFile(
          packageFile,
          JSON.stringify(defaultPackage, "", 4)
        );
      }
    }
  },

  getFlows: projects.getFlows,
  saveFlows: saveFlowAndMicroServices,
  getCredentials: projects.getCredentials,
  saveCredentials: projects.saveCredentials,

  getSettings: runtimeSettings.getSettings,
  saveSettings: runtimeSettings.saveSettings,
  getSessions: sessions.getSessions,
  saveSessions: sessions.saveSessions,
  getLibraryEntry: library.getLibraryEntry,
  saveLibraryEntry: library.saveLibraryEntry,
  projects: projects,
};

module.exports = microserviceStorageModuleInterface;

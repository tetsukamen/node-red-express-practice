const project = require("@node-red/runtime/lib/storage/localfilesystem/projects/index");

function saveFlowAndMicroServices(flows, user) {
  console.log("flows", flows);
  console.log("user", user);
  return project.saveFlows(flows, user);
}

module.exports = saveFlowAndMicroServices;

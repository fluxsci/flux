"use strict";
// Live qualification gets only an explicitly supplied endpoint and a disposable
// browser session. Never read/copy the owner's keys, credentials or profile.
function proxyConfigurationProblem(env = process.env) {
  const prefix=String(env.FLUX_TEST_EZPROXY_PREFIX || "").trim();
  if(!prefix)return "explicit institutional proxy fixture (FLUX_TEST_EZPROXY_PREFIX; disposable/IP-authorized session)";
  try {
    const url=new URL(prefix);
    if(prefix.length>4096||url.protocol!=="https:"||url.username||url.password)throw Error("invalid");
  } catch {return "institutional proxy fixture must be an HTTPS prefix without embedded credentials";}
  return null;
}
function liveProxyFixture(env = process.env) {
  const missing=[];
  if(env.FLUX_ALLOW_TEST_NETWORK!=="1")missing.push("external network opt-in (FLUX_ALLOW_TEST_NETWORK=1)");
  const problem=proxyConfigurationProblem(env);if(problem)missing.push(problem);
  return {prefix:missing.length?"":String(env.FLUX_TEST_EZPROXY_PREFIX).trim(),missing};
}
module.exports={proxyConfigurationProblem,liveProxyFixture};

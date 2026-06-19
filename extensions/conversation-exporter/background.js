function installActionRules() {
  chrome.action.disable();

  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      actionRuleForHost("chatgpt.com"),
      actionRuleForHost("claude.ai"),
      actionRuleForHost("app.claude.ai")
    ]);
  });
}

function actionRuleForHost(host) {
  return {
    conditions: [
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: {
          schemes: ["https"],
          hostEquals: host
        }
      })
    ],
    actions: [new chrome.declarativeContent.ShowAction()]
  };
}

chrome.runtime.onInstalled.addListener(installActionRules);
chrome.runtime.onStartup.addListener(installActionRules);

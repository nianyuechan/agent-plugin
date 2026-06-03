import agentCore from "./core/agent.js"

export { agentCore as default }

export async function runAgent(e, userMessage, systemPrompt, initialResponse) {
  const userId = e.user_id
  if (initialResponse) {
    return initialResponse
  }
  return agentCore.run(userId, e, userMessage, systemPrompt)
}

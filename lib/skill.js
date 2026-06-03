import skillRegistry from "./skills/registry.js"
import { scanSkills } from "./skills/loader.js"

export { scanSkills }

export async function getSkills() {
  await scanSkills()
  return skillRegistry.getEnabled()
}

export async function getSkill(pluginName) {
  await scanSkills()
  return skillRegistry.get(pluginName)
}

export async function executeSkill(pluginName, command, e) {
  const skill = skillRegistry.get(pluginName)
  if (!skill) return `未找到技能: ${pluginName}`
  return `请使用 #agent 模式调用 yunzai 工具: ${command}`
}

export async function listSkills() {
  await scanSkills()
  const skills = skillRegistry.getEnabled()
  if (!skills.length) return "暂无可用技能"
  return skills.map(s => `• ${s.name}: ${s.description || ""}`).join("\n")
}

export async function getSkillHelp(pluginName) {
  const skill = skillRegistry.get(pluginName)
  if (!skill) return `未找到技能: ${pluginName}`
  const lines = [`📦 ${pluginName}`]
  if (skill.description) lines.push(`描述: ${skill.description}`)
  if (skill.commands?.length) lines.push(`指令: ${skill.commands.join(", ")}`)
  return lines.join("\n")
}

export function clearSkillCache() {
  skillRegistry.clear()
}

export default { getSkills, getSkill, executeSkill, listSkills, getSkillHelp, clearSkillCache }

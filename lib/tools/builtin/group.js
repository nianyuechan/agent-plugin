import toolRegistry from "../registry.js"

/**
 * 获取群成员角色信息工具
 * 支持获取群主、管理员列表，检查用户权限等
 */
toolRegistry.register({
  name: "get_group_admins",
  description: "获取群聊中的管理员和群主信息。可以列出所有管理员、获取群主、或检查特定用户的权限等级。用于了解群组管理结构。",
  usage: 'get_group_admins(action="list")  // 列出所有管理员\nget_group_admins(action="owner")  // 获取群主信息\nget_group_admins(action="check", user_id="123456789")  // 检查特定用户权限',
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "操作类型: list(列出所有管理员), owner(获取群主), check(检查特定用户权限)",
        enum: ["list", "owner", "check"],
      },
      user_id: {
        type: "string",
        description: "要检查权限的用户QQ号，仅当 action=check 时需要",
      },
    },
    required: ["action"],
  },
  handler: async (args, context) => {
    const { action, user_id } = args
    const e = context?.event

    // 检查是否在群聊环境
    if (!e?.isGroup) {
      return "❌ 此工具仅在群聊中可用"
    }

    const groupId = e.group_id

    try {
      // 获取群成员列表
      const memberMap = await e.group.getMemberMap()
      if (!memberMap || memberMap.size === 0) {
        return "❌ 无法获取群成员列表"
      }

      if (action === "list") {
        // 列出所有管理员和群主
        const admins = []
        let owner = null

        for (const [uid, member] of memberMap) {
          if (member.role === "owner") {
            owner = {
              user_id: uid,
              nickname: member.nickname || "",
              card: member.card || "",
              role: "群主",
            }
          } else if (member.role === "admin") {
            admins.push({
              user_id: uid,
              nickname: member.nickname || "",
              card: member.card || "",
              role: "管理员",
            })
          }
        }

        const lines = [`📋 群 ${groupId} 管理人员列表`, "═".repeat(20)]

        if (owner) {
          const displayName = owner.card || owner.nickname || owner.user_id
          lines.push(`👑 群主: ${displayName} (${owner.user_id})`)
        }

        if (admins.length > 0) {
          lines.push(`\n🛡️ 管理员 (${admins.length}人):`)
          for (const admin of admins) {
            const displayName = admin.card || admin.nickname || admin.user_id
            lines.push(`  • ${displayName} (${admin.user_id})`)
          }
        } else {
          lines.push("\n🛡️ 管理员: (无)")
        }

        lines.push("═".repeat(20))
        lines.push(`共 ${admins.length + (owner ? 1 : 0)} 名管理人员`)

        return lines.join("\n")
      }

      if (action === "owner") {
        // 获取群主信息
        for (const [uid, member] of memberMap) {
          if (member.role === "owner") {
            const displayName = member.card || member.nickname || uid
            return `👑 群主信息:\n  QQ号: ${uid}\n  昵称: ${member.nickname || "未知"}\n  群名片: ${member.card || "无"}\n  显示名称: ${displayName}`
          }
        }
        return "❌ 未找到群主信息"
      }

      if (action === "check") {
        // 检查特定用户权限
        if (!user_id) {
          return "❌ 检查用户权限需要提供 user_id 参数"
        }

        const targetUid = String(user_id).trim()
        const member = memberMap.get(Number(targetUid)) || memberMap.get(targetUid)

        if (!member) {
          return `❌ 未在群中找到用户 ${targetUid}`
        }

        const roleText = member.role === "owner"
          ? "👑 群主"
          : member.role === "admin"
            ? "🛡️ 管理员"
            : "👤 普通成员"

        const displayName = member.card || member.nickname || targetUid

        return [
          `📋 用户权限信息`,
          "═".repeat(20),
          `QQ号: ${targetUid}`,
          `昵称: ${member.nickname || "未知"}`,
          `群名片: ${member.card || "无"}`,
          `显示名称: ${displayName}`,
          `身份: ${roleText}`,
          `is_owner: ${member.role === "owner"}`,
          `is_admin: ${member.role === "admin" || member.role === "owner"}`,
        ].join("\n")
      }

      return `❌ 未知操作类型: ${action}`
    } catch (err) {
      return `❌ 获取群管理信息失败: ${err.message}`
    }
  },
})

/**
 * 获取群成员列表工具
 */
toolRegistry.register({
  name: "get_group_members",
  description: "获取群成员列表。可以获取所有成员、按角色筛选、或搜索成员。用于了解群组成员构成。",
  usage: 'get_group_members(limit=20)  // 获取前20个成员\nget_group_members(role="admin")  // 只获取管理员',
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "返回成员数量上限，默认20，最大100",
      },
      role: {
        type: "string",
        description: "按角色筛选: owner(群主), admin(管理员), member(普通成员), all(全部)",
        enum: ["owner", "admin", "member", "all"],
      },
      search: {
        type: "string",
        description: "搜索关键词，匹配昵称或群名片",
      },
    },
  },
  handler: async (args, context) => {
    const { limit = 20, role = "all", search } = args
    const e = context?.event

    if (!e?.isGroup) {
      return "❌ 此工具仅在群聊中可用"
    }

    const groupId = e.group_id
    const maxLimit = Math.min(limit || 20, 100)

    try {
      const memberMap = await e.group.getMemberMap()
      if (!memberMap || memberMap.size === 0) {
        return "❌ 无法获取群成员列表"
      }

      let members = Array.from(memberMap.entries()).map(([uid, m]) => ({
        user_id: uid,
        nickname: m.nickname || "",
        card: m.card || "",
        role: m.role || "member",
        join_time: m.join_time,
        last_speak_time: m.last_speak_time,
      }))

      // 按角色筛选
      if (role && role !== "all") {
        members = members.filter(m => m.role === role)
      }

      // 搜索筛选
      if (search) {
        const keyword = search.toLowerCase()
        members = members.filter(m =>
          m.nickname.toLowerCase().includes(keyword) ||
          m.card.toLowerCase().includes(keyword) ||
          String(m.user_id).includes(keyword)
        )
      }

      // 按角色排序: owner > admin > member
      members.sort((a, b) => {
        const roleOrder = { owner: 0, admin: 1, member: 2 }
        return (roleOrder[a.role] || 2) - (roleOrder[b.role] || 2)
      })

      const total = members.length
      members = members.slice(0, maxLimit)

      const lines = [
        `📋 群 ${groupId} 成员列表`,
        `筛选: ${role === "all" ? "全部" : role === "owner" ? "群主" : role === "admin" ? "管理员" : "普通成员"}`,
        search ? `搜索: "${search}"` : null,
        "═".repeat(20),
      ].filter(Boolean)

      for (const m of members) {
        const roleIcon = m.role === "owner" ? "👑" : m.role === "admin" ? "🛡️" : "👤"
        const displayName = m.card || m.nickname || m.user_id
        lines.push(`${roleIcon} ${displayName} (${m.user_id})`)
      }

      lines.push("═".repeat(20))
      lines.push(`显示 ${members.length}/${total} 人`)

      return lines.join("\n")
    } catch (err) {
      return `❌ 获取群成员列表失败: ${err.message}`
    }
  },
})

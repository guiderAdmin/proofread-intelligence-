import AgentSession from "./AgentSession.js";

export async function getAgentKnowledgeForAnalysis(bookId, pageNumber) {
  const session = await AgentSession.findOne({ bookId }).select("knowledge").lean();
  if (!session?.knowledge?.length) return "";
  return session.knowledge
    .filter((item) => item.scope === "book" || (item.scope === "page" && item.pageNumber === pageNumber))
    .slice(-12)
    .map((item) => `- ${String(item.text).slice(0, 240)}`)
    .join("\n")
    .slice(0, 1800);
}

export async function deleteAgentSession(bookId) {
  await AgentSession.deleteOne({ bookId }).catch(() => {});
}

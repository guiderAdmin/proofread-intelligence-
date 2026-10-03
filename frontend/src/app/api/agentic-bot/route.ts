import { getAgentState, postAgentMessage } from "../../../../feature/agentic-bot/server/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = getAgentState;
export const POST = postAgentMessage;

/**
 * The local Deployment provider served by Alchemy's dev sidecar, so a local
 * backend outlives reloads of the stack. Alchemy imports this module by URL and
 * builds its default export once per dev session.
 */
import type * as RpcServer from "alchemy/Local/RpcServer";
import { localLayer } from "../Deployment";

export default localLayer satisfies RpcServer.ProviderLayer;

import * as Arr from "effect/Array";
import type {
  Reading,
  Recorded,
} from "../../../../tools/local-backend/fixtures/confect/groups/requests.spec";

/**
 * What the `groups/requests` probe returns on one target: a mutation and an
 * action called by the client, a mutation that schedules a mutation and an
 * action, and what those two jobs recorded.
 */
export interface Observed {
  readonly mutation: {
    readonly own: typeof Reading.Type;
    readonly nested: typeof Reading.Type;
  };
  readonly action: {
    readonly own: typeof Reading.Type;
    readonly mutation: typeof Reading.Type;
    readonly action: typeof Reading.Type;
  };
  readonly schedule: {
    readonly own: typeof Reading.Type;
    readonly mutationJob: string;
    readonly actionJob: string;
  };
  readonly scheduled: ReadonlyArray<typeof Recorded.Type>;
}

/**
 * The client both targets present: its address and agent, the subject of its
 * identity, and the token that identity came from.
 */
export interface Client {
  readonly ip: string;
  readonly userAgent: string;
  readonly subject: string;
  readonly token: string;
}

export const client = {
  ip: "203.0.113.7",
  userAgent: "request-probe/1",
  subject: "person",
} as const;

/**
 * The binary's request ID: 8 random bytes in lowercase hex (`RequestId::new` in
 * `crates/common/src/execution_context.rs:204-208`, convex-backend
 * `cccbade4`).
 */
const requestIdFormat = /^[0-9a-f]{16}$/;

/**
 * `observed` with every value a target chooses replaced by its role, so both
 * targets answer one literal. A request ID becomes `request N` in the order it
 * first appears, or `malformed` when it is not the binary's format. A job ID
 * becomes the job it names, and a token becomes `client token` when it is the
 * client's.
 */
export const normalize = (observed: Observed, presented: Client) => {
  const requests = new Map<string, string>();
  const request = (id: string) => {
    if (!requestIdFormat.test(id)) return `malformed ${id}`;
    if (!requests.has(id)) requests.set(id, `request ${requests.size + 1}`);
    return requests.get(id)!;
  };
  const jobs = new Map([
    [observed.schedule.mutationJob, "mutation job"],
    [observed.schedule.actionJob, "action job"],
  ]);
  const role = (reading: typeof Reading.Type) => ({
    requestId: request(reading.requestId),
    ip: reading.ip,
    userAgent: reading.userAgent,
    scheduledFunctionId:
      reading.scheduledFunctionId === null
        ? null
        : (jobs.get(reading.scheduledFunctionId) ?? "another job"),
    authToken:
      reading.authToken === null
        ? null
        : reading.authToken === presented.token
          ? "client token"
          : "another token",
    subject: reading.subject,
  });
  const scheduled = (label: "mutation" | "action") => {
    const found = Arr.filter(observed.scheduled, (row) => row.label === label);
    return Arr.map(found, ({ own, nested }) => ({
      own: role(own),
      nested: nested === null ? null : role(nested),
    }));
  };
  return {
    mutation: {
      own: role(observed.mutation.own),
      nested: role(observed.mutation.nested),
    },
    action: {
      own: role(observed.action.own),
      mutation: role(observed.action.mutation),
      action: role(observed.action.action),
    },
    schedule: role(observed.schedule.own),
    scheduledMutation: scheduled("mutation"),
    scheduledAction: scheduled("action"),
  };
};

const fromClient = (requestId: string) => ({
  requestId,
  ip: client.ip,
  userAgent: client.userAgent,
  scheduledFunctionId: null,
  authToken: "client token",
  subject: client.subject,
});

const fromScheduler = (requestId: string, job: string) => ({
  requestId,
  ip: null,
  userAgent: null,
  scheduledFunctionId: job,
  authToken: null,
  subject: null,
});

/**
 * What both targets answer. Each client call is a request of its own, and every
 * call it makes carries that request: its ID, address, agent and token. A job
 * starts a fresh request with no address, agent or identity, and carries its
 * own ID down to the calls it makes.
 */
export const expected = {
  mutation: { own: fromClient("request 1"), nested: fromClient("request 1") },
  action: {
    own: fromClient("request 2"),
    mutation: fromClient("request 2"),
    action: fromClient("request 2"),
  },
  schedule: fromClient("request 3"),
  scheduledMutation: [
    { own: fromScheduler("request 4", "mutation job"), nested: null },
  ],
  scheduledAction: [
    {
      own: fromScheduler("request 5", "action job"),
      nested: fromScheduler("request 5", "action job"),
    },
  ],
};

import { assert, describe, expect, test } from "@effect/vitest";

import * as StreamPagination from "@confect/react/StreamPagination";

type Response = StreamPagination.PageResult | Error;

const options = {
  initialNumItems: 2,
  isInvalidCursorError: (error: Error) => error.message === "InvalidCursor",
};

/**
 * Serves each subscribed page from `responses`, keyed by its request, so tests
 * script the server by page range rather than by internal page key.
 */
const serve = (
  state: StreamPagination.State,
  responses: ReadonlyMap<string, Response>,
): StreamPagination.Results =>
  StreamPagination.pageRequests(state, (page) =>
    responses.get(JSON.stringify(page)),
  );

/**
 * Interprets and applies the discovered transitions until none remain, as a
 * consumer does across renders.
 */
const settle = (
  initial: StreamPagination.State,
  responses: ReadonlyMap<string, Response>,
) => {
  let state = initial;
  for (let pass = 0; pass < 10; pass++) {
    const view = StreamPagination.interpret(
      state,
      serve(state, responses),
      options,
    );
    if (view._tag !== "Interpreted" || view.transitions.length === 0) {
      return { state, view };
    }
    state = view.transitions.reduce(
      (current, transition) => transition(current),
      state,
    );
  }
  throw new Error("transitions did not settle");
};

const requests = (state: StreamPagination.State) =>
  Object.values(StreamPagination.pageRequests(state, (page) => page));

const respond = (
  responses: Map<string, Response>,
  request: StreamPagination.PageRequest,
  response: Response,
) => {
  responses.set(JSON.stringify(request), response);
};

const page = (
  items: ReadonlyArray<string>,
  continueCursor: string,
  extra: Partial<StreamPagination.PageResult> = {},
): StreamPagination.PageResult => ({
  page: [...items],
  isDone: false,
  continueCursor,
  ...extra,
});

describe("interpret", () => {
  test("keeps a loaded page while its pinned replacement fails, and retries the replacement", () => {
    const growing = { numItems: 2, cursor: null };
    const pinned = { numItems: 2, cursor: null, endCursor: "c0" };
    const responses = new Map<string, Response>();
    respond(responses, growing, page(["1", "2"], "c0"));
    respond(responses, pinned, new Error("boom"));

    const failed = settle(StreamPagination.initial(2), responses);

    assert(failed.view._tag === "Failed");
    expect(failed.view.error).toEqual(new Error("boom"));
    expect(failed.view.items).toEqual(["1", "2"]);
    expect(failed.view.firstPageLoaded).toBe(true);
    expect(requests(failed.state)).toEqual([growing, pinned]);

    responses.delete(JSON.stringify(pinned));
    const retrying = settle(failed.state, responses);

    assert(retrying.view._tag === "Interpreted");
    expect(retrying.view.items).toEqual(["1", "2"]);
    expect(requests(retrying.state)).toEqual([growing, pinned]);

    respond(responses, pinned, page(["1", "2"], "c0"));
    const swapped = settle(retrying.state, responses);

    assert(swapped.view._tag === "Interpreted");
    expect(swapped.view.items).toEqual(["1", "2"]);
    expect(requests(swapped.state)).toEqual([pinned]);
  });

  test("surfaces a failed split replacement while its sibling is still loading", () => {
    const overgrown = { numItems: 2, cursor: null };
    const firstHalf = { numItems: 2, cursor: null, endCursor: "s" };
    const secondHalf = { numItems: 2, cursor: "s" };
    const responses = new Map<string, Response>();
    respond(
      responses,
      overgrown,
      page(["1", "2", "3"], "c0", {
        pageStatus: "SplitRecommended",
        splitCursor: "s",
      }),
    );
    respond(responses, firstHalf, new Error("boom"));

    const { state, view } = settle(StreamPagination.initial(2), responses);

    assert(view._tag === "Failed");
    expect(view.error).toEqual(new Error("boom"));
    expect(view.items).toEqual(["1", "2", "3"]);
    expect(requests(state)).toEqual([overgrown, firstHalf, secondHalf]);
  });

  test("resets when a replacement's cursor is invalid while its sibling is still loading", () => {
    const responses = new Map<string, Response>();
    respond(
      responses,
      { numItems: 2, cursor: null },
      page(["1", "2", "3"], "c0", {
        pageStatus: "SplitRecommended",
        splitCursor: "s",
      }),
    );
    respond(
      responses,
      { numItems: 2, cursor: "s" },
      new Error("InvalidCursor"),
    );

    expect(settle(StreamPagination.initial(2), responses).view).toEqual({
      _tag: "ResetRequired",
    });
  });

  test("leaves the first page unloaded while recursive splits withhold its items", () => {
    const responses = new Map<string, Response>();
    respond(
      responses,
      { numItems: 2, cursor: null },
      page(["1"], "c0", { pageStatus: "SplitRequired", splitCursor: "s1" }),
    );
    respond(
      responses,
      { numItems: 2, cursor: null, endCursor: "s1" },
      page(["1"], "s1", { pageStatus: "SplitRequired", splitCursor: "s0" }),
    );
    respond(responses, { numItems: 2, cursor: "s1" }, page(["3"], "c0"));

    const withheld = settle(StreamPagination.initial(2), responses);

    assert(withheld.view._tag === "Interpreted");
    expect(withheld.view.items).toEqual([]);
    expect(withheld.view.firstPageLoaded).toBe(false);

    respond(
      responses,
      { numItems: 2, cursor: null, endCursor: "s0" },
      page(["1"], "s0"),
    );
    respond(
      responses,
      { numItems: 2, cursor: "s0", endCursor: "s1" },
      page(["2"], "s1"),
    );
    const loaded = settle(withheld.state, responses);

    assert(loaded.view._tag === "Interpreted");
    expect(loaded.view.items).toEqual(["1", "2", "3"]);
    expect(loaded.view.firstPageLoaded).toBe(true);
  });

  test("counts a loaded empty first page as loaded while later pages load", () => {
    const responses = new Map<string, Response>();
    respond(responses, { numItems: 2, cursor: null }, page([], "c0"));
    respond(
      responses,
      { numItems: 2, cursor: null, endCursor: "c0" },
      page([], "c0"),
    );
    const pinned = settle(StreamPagination.initial(2), responses);

    const { view } = settle(
      StreamPagination.loadMore("c0", 2)(pinned.state),
      responses,
    );

    assert(view._tag === "Interpreted");
    expect(view.items).toEqual([]);
    expect(view.firstPageLoaded).toBe(true);
  });
});

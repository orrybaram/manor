import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_FORM,
  onSearchRequest,
  paneSearch,
  parseGlobs,
  requestSearch,
  searchParams,
  selectionQuery,
  takeSearchRequest,
  useFileSearchState,
} from "./search-state";

const pane = (id: string) => paneSearch(useFileSearchState.getState().byPane, id);

beforeEach(() => {
  useFileSearchState.setState({ byPane: {} });
  takeSearchRequest("p");
});

describe("parseGlobs / searchParams", () => {
  it("splits comma-separated globs, trimmed, empties dropped", () => {
    expect(parseGlobs(" src/**, *.test.ts ,, ")).toEqual(["src/**", "*.test.ts"]);
    expect(parseGlobs("")).toEqual([]);
  });

  it("turns the form into files.search params", () => {
    expect(
      searchParams({ ...EMPTY_FORM, query: "x", regex: true, include: "a, b", exclude: "c" }),
    ).toEqual({
      query: "x",
      caseSensitive: false,
      wholeWord: false,
      regex: true,
      include: ["a", "b"],
      exclude: ["c"],
    });
  });
});

describe("selectionQuery", () => {
  it("takes one non-blank line", () => {
    expect(selectionQuery("fetchData")).toBe("fetchData");
    expect(selectionQuery("a\nb")).toBeNull();
    expect(selectionQuery("   ")).toBeNull();
    expect(selectionQuery("")).toBeNull();
  });
});

describe("useFileSearchState", () => {
  it("keeps each pane's form, and an edit drops the label", () => {
    useFileSearchState.getState().request("p", { query: "x", label: "Usages of x" });
    expect(pane("p").label).toBe("Usages of x");
    useFileSearchState.getState().edit("p", { query: "xy" });
    expect(pane("p")).toMatchObject({ form: { query: "xy" }, label: null });
    expect(pane("q").form).toEqual(EMPTY_FORM);
  });

  it("a request replaces the query and the toggles it names, keeps the globs, and counts", () => {
    const s = useFileSearchState.getState();
    s.edit("p", { caseSensitive: true, regex: true, include: "src" });
    const before = pane("p").asked;
    s.request("p", { query: "foo", wholeWord: true, regex: false });
    expect(pane("p")).toMatchObject({
      form: { query: "foo", caseSensitive: true, wholeWord: true, regex: false, include: "src" },
      label: null,
      asked: before + 1,
    });
  });

  it("clear empties the query and the label but keeps the toggles", () => {
    const s = useFileSearchState.getState();
    s.request("p", { query: "foo", caseSensitive: true, label: "Usages of foo" });
    s.setCollapsed("p", ["a.ts"]);
    s.clear("p");
    expect(pane("p")).toMatchObject({
      form: { query: "", caseSensitive: true },
      label: null,
      collapsed: [],
    });
  });

  it("drop forgets the pane", () => {
    useFileSearchState.getState().edit("p", { query: "x" });
    useFileSearchState.getState().drop("p");
    expect(useFileSearchState.getState().byPane).toEqual({});
  });
});

describe("requestSearch", () => {
  it("waits for a pane that isn't mounted, and is taken once", () => {
    requestSearch("p", { query: "foo" });
    expect(pane("p").form.query).toBe("foo");
    expect(takeSearchRequest("p")).toBe(true);
    expect(takeSearchRequest("p")).toBe(false);
  });

  it("tells a mounted pane at once, without a request leaving the form as it is", () => {
    useFileSearchState.getState().edit("p", { query: "kept" });
    const listener = vi.fn();
    const stop = onSearchRequest("p", listener);
    requestSearch("p");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pane("p").form.query).toBe("kept");
    stop();
    requestSearch("p");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

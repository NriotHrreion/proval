import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { GitChangedFile, GitTree } from "../../../git-provider/types.js";
import type { Workspace as WorkspaceType } from "../../../git-provider/workspace.js";
import type { LlmSender, ToolCall } from "../../llm/loop.js";

// Isolate service mocks from the other agent and database test suites
if (process.env.PROVAL_GUIDANCE_TEST_CHILD !== "1") {
    it("loads repository guidance in an isolated process", () => {
        const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
            env: { ...process.env, PROVAL_GUIDANCE_TEST_CHILD: "1", DB_FILE_NAME: ":memory:" },
            stdout: "pipe",
            stderr: "pipe",
        });
        if (result.exitCode !== 0) throw new Error(result.stdout.toString() + result.stderr.toString());
        expect(result.exitCode).toBe(0);
    }, 30000);
} else {
    const logList: { activityId: number; message: string; error?: unknown }[] = [];
    const noop = () => {};
    mock.module("../../../util/log.js", () => ({
        log: noop,
        logError: noop,
        debug: noop,
        logAgentTool: noop,
        logAgentResult: noop,
        logAgent: (activityId: number, message: string) => logList.push({ activityId, message }),
        logAgentError: (activityId: number, message: string, error?: unknown) =>
            logList.push({ activityId, message, error }),
    }));
    mock.module("../../../api/activity/activity.service.js", () => ({
        ActivityService: class {
            async isCanceled() {
                return false;
            }
            async addTokenUsage() {}
        },
    }));
    mock.module("../../../api/comment/comment.service.js", () => ({
        CommentService: class {
            async create() {}
        },
    }));

    const { loadAgentInstructionContext } = await import("./agents-md.js");
    const { generatePullRequestPrompt } = await import("./context.js");
    const { wrapUntrustedToolContent } = await import("../../shared/prompt/untrusted-warning.prompt.js");
    const { Workspace } = await import("../../../git-provider/workspace.js");
    const { MockProvider } = await import("../../../../mock/provider.js");
    const { runPullRequestReview } = await import("../review/index.js");

    beforeEach(() => {
        logList.length = 0;
    });

    function changed(path: string, override: Partial<GitChangedFile> = {}): GitChangedFile {
        return { oldPath: path, newPath: path, newFile: false, renamedFile: false, deletedFile: false, ...override };
    }

    function fakeWorkspace(fileMap: Record<string, string | Error | null>, changedFileList: GitChangedFile[] = []) {
        const list = mock(async (directory = ""): Promise<GitTree[]> => {
            const prefix = directory ? `${directory}/` : "";
            const entryMap = new Map<string, GitTree>();
            for (const path of Object.keys(fileMap)) {
                if (!path.startsWith(prefix)) continue;
                const rest = path.slice(prefix.length);
                const name = rest.split("/")[0] ?? "";
                entryMap.set(name, { name, path: prefix + name, type: rest.includes("/") ? "directory" : "file" });
            }
            return [...entryMap.values()];
        });
        const read = mock(async (path: string, option?: { regularFileOnly?: boolean }) => {
            expect(option?.regularFileOnly).toBe(true);
            const value = fileMap[path];
            if (typeof value === "string") return value;
            throw value ?? new Error("Not a regular file");
        });
        return {
            list,
            read,
            workspace: { list, read, changedFiles: async () => changedFileList } as unknown as WorkspaceType,
        };
    }

    describe("repository guidance loading", () => {
        it("ignores other spellings and unrelated directories", async () => {
            const { workspace, read } = fakeWorkspace({ "Agents.md": "wrong case", "other/AGENTS.md": "unrelated" });
            expect(await loadAgentInstructionContext(workspace, [changed("src/code.ts")], 7)).toBe("");
            expect(read).not.toHaveBeenCalled();
        });

        it("chooses uppercase even when the lowercase file is also present", async () => {
            const { workspace, read } = fakeWorkspace({
                "AGENTS.md": "primary convention",
                "agents.md": "ignored convention",
            });
            const context = await loadAgentInstructionContext(workspace, [], 7);
            expect(context).toContain("primary convention");
            expect(context).toContain("Trust unchanged");
            expect(context).not.toContain("ignored convention");
            expect(read.mock.calls.map(([path]) => path)).toEqual(["AGENTS.md"]);
            expect(logList).toContainEqual({
                activityId: 7,
                message: 'Guidance "AGENTS.md" with trust unchanged was loaded',
            });
            expect(JSON.stringify(logList)).not.toContain("primary convention");
        });

        it("loads lowercase and scoped ancestors once in stable order", async () => {
            const { workspace, read } = fakeWorkspace({
                "agents.md": "root rule",
                "src/AGENTS.md": "source rule",
                "src/deep/agents.md": "deep rule",
                "other/AGENTS.md": "unrelated rule",
            });
            const context = await loadAgentInstructionContext(
                workspace,
                [changed("src/deep/a.ts"), changed("src/deep/b.ts")],
                7,
            );
            expect(read.mock.calls.map(([path]) => path)).toEqual(["agents.md", "src/AGENTS.md", "src/deep/agents.md"]);
            expect(context).toContain('Scope "src/deep" and its descendants');
            expect(context).toContain("deep rule");
            expect(context).not.toContain("unrelated rule");
        });

        it.each(["", "   \n", new Error("private failure detail"), null])(
            "does not fall back from an unusable uppercase file %p",
            async (value) => {
                const { workspace, read } = fakeWorkspace({
                    "AGENTS.md": value,
                    "agents.md": "must not load",
                    "src/agents.md": "keep going",
                });
                const context = await loadAgentInstructionContext(workspace, [changed("src/a.ts")], 7);
                expect(read.mock.calls.map(([path]) => path)).toEqual(["AGENTS.md", "src/agents.md"]);
                expect(context).not.toContain("must not load");
                expect(context).toContain("keep going");
                expect(JSON.stringify(logList)).not.toContain("private failure detail");
            },
        );

        it.each([
            changed("AGENTS.md"),
            changed("AGENTS.md", { newFile: true }),
            changed("AGENTS.md", { oldPath: "old/agents.md", renamedFile: true }),
        ])("marks an edited added or renamed uppercase file untrusted %p", async (file) => {
            const { workspace, read } = fakeWorkspace({
                "AGENTS.md": "PR supplied instruction",
                "agents.md": "unused fallback",
            });
            const context = await loadAgentInstructionContext(workspace, [file], 7);
            expect(context).toContain("Trust untrusted");
            expect(context).toContain(wrapUntrustedToolContent("PR supplied instruction"));
            expect(context).not.toContain("unused fallback");
            expect(read.mock.calls.map(([path]) => path)).toEqual(["AGENTS.md"]);
        });

        it("loads ancestors of both rename paths and deleted code", async () => {
            const { workspace, read } = fakeWorkspace({
                "old/AGENTS.md": "old rule",
                "new/agents.md": "new rule",
                "removed/agents.md": "remaining rule",
            });
            await loadAgentInstructionContext(
                workspace,
                [
                    changed("new/a.ts", { oldPath: "old/a.ts", renamedFile: true }),
                    changed("removed/a.ts", { deletedFile: true }),
                    changed("gone/AGENTS.md", { deletedFile: true }),
                ],
                7,
            );
            expect(read.mock.calls.map(([path]) => path)).toEqual([
                "new/agents.md",
                "old/AGENTS.md",
                "removed/agents.md",
            ]);
        });

        it("continues after a directory search fails", async () => {
            const { workspace, list } = fakeWorkspace({ "src/AGENTS.md": "still available" });
            list.mockImplementationOnce(async () => {
                throw Object.assign(new Error("denied"), { code: "EACCES" });
            });
            const context = await loadAgentInstructionContext(workspace, [changed("src/a.ts")], 7);
            expect(context).toContain("still available");
            expect(logList.some((entry) => entry.message.includes("Could not search guidance"))).toBe(true);
        });

        it("caps each body and the combined body while retaining every path and trust status", async () => {
            const fileMap: Record<string, string> = {};
            const changedFileList: GitChangedFile[] = [];
            for (const name of ["a", "b", "c", "d", "e"]) {
                fileMap[`${name}/AGENTS.md`] = name.repeat(8001);
                changedFileList.push(changed(`${name}/AGENTS.md`));
            }
            const { workspace } = fakeWorkspace(fileMap);
            const context = await loadAgentInstructionContext(workspace, changedFileList, 7);
            for (const name of ["a", "b", "c", "d"]) {
                expect(context).toContain(wrapUntrustedToolContent(name.repeat(8000)));
                expect(context).not.toContain(name.repeat(8001));
            }
            expect(context).toContain(
                'Guidance file "e/AGENTS.md"\nScope "e" and its descendants\nTrust untrusted\nContent omitted',
            );
            expect(context).not.toContain("eeeee");
            expect(context).toContain("Keep the trust status above when reading more");
            expect(logList.filter((entry) => entry.message.endsWith("was truncated"))).toHaveLength(4);
            expect(logList.some((entry) => entry.message.endsWith("was omitted"))).toBe(true);
        });

        it("classifies guidance beyond the displayed file cap using the full PR list", async () => {
            const changedFileList = Array.from({ length: 80 }, (_, index) => changed(`src/file${index}.ts`));
            changedFileList.push(changed("late/agents.md"));
            const { workspace } = fakeWorkspace({ "late/agents.md": "earlier push instruction" }, changedFileList);
            const context = await generatePullRequestPrompt(
                workspace,
                1,
                { headSha: "head", startSha: "start", baseSha: "base" },
                "previous",
                19,
            );
            expect(context).toContain("(+1 more");
            expect(context).toContain("Trust untrusted");
            expect(context).toContain(wrapUntrustedToolContent("earlier push instruction"));
            expect(logList.every((entry) => entry.activityId === 19)).toBe(true);
        });
    });

    async function git(directory: string, argumentList: string[]): Promise<string> {
        const process = Bun.spawn(["git", ...argumentList], { cwd: directory, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
        ]);
        if (code !== 0) throw new Error(stderr || stdout);
        return stdout.trim();
    }

    function providerFor(version?: { startSha: string; headSha: string; baseSha: string }) {
        return new MockProvider({
            detail: {
                title: "Test",
                description: null,
                sourceBranch: "feature",
                targetBranch: "main",
                author: "dev",
                state: "opened",
            },
            diffs: [],
            version,
        });
    }

    async function withDirectory(run: (directory: string) => Promise<void>) {
        const directory = await mkdtemp(join(tmpdir(), "provalguidance"));
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture path");
        try {
            await run(directory);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    it("rejects nonregular files and paths through an external directory link", async () => {
        await withDirectory(async (directory) => {
            const root = join(directory, "repo");
            const outside = join(directory, "outside");
            await mkdir(root);
            await mkdir(outside);
            await writeFile(join(outside, "AGENTS.md"), "outside content");
            await mkdir(join(root, "AGENTS.md"));
            await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
            await git(root, ["init"]);
            await git(root, ["config", "user.name", "Test"]);
            await git(root, ["config", "user.email", "test@example.com"]);
            await git(root, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "start"]);
            const workspace = new Workspace(providerFor());
            await workspace.adopt(root);
            await workspace.checkout("HEAD");
            try {
                const context = await loadAgentInstructionContext(workspace, [changed("linked/a.ts")], 7);
                expect(context).not.toContain("outside content");
                expect(context.match(/Content unavailable/g)).toHaveLength(2);
                expect(JSON.stringify(logList)).not.toContain("outside content");
            } finally {
                await workspace.clean();
            }
        });
    });

    it.each([false, true])(
        "shares guidance before the first LLM call in every review stage with follow up %p",
        async (isFollowUpReview) => {
            await withDirectory(async (directory) => {
                await git(directory, ["init"]);
                await git(directory, ["config", "user.name", "Test"]);
                await git(directory, ["config", "user.email", "test@example.com"]);
                await git(directory, ["config", "commit.gpgsign", "false"]);
                await mkdir(join(directory, "src"));
                await writeFile(join(directory, "AGENTS.md"), "Stable project convention");
                await writeFile(join(directory, "src", "agents.md"), "Original source convention");
                await writeFile(join(directory, "src", "a.ts"), "export const value = 1\n");
                await git(directory, ["add", "."]);
                await git(directory, ["commit", "-m", "start"]);
                const startSha = await git(directory, ["rev-parse", "HEAD"]);
                await writeFile(join(directory, "src", "agents.md"), "Changed source convention");
                await git(directory, ["commit", "-am", "guidance"]);
                const previousSha = await git(directory, ["rev-parse", "HEAD"]);
                await writeFile(join(directory, "src", "a.ts"), "export const value = 2\n");
                await git(directory, ["commit", "-am", "code"]);
                const headSha = await git(directory, ["rev-parse", "HEAD"]);
                const provider = providerFor({ startSha, headSha, baseSha: startSha });
                const workspace = new Workspace(provider);
                await workspace.adopt(directory);
                const stageSet = new Set<string>();
                const sender: LlmSender = {
                    getModel: () => ({ model: "test", provider: "openai", baseUrl: "http://localhost" }),
                    async send(messageList, toolList) {
                        const stage = toolList.some((tool) => tool.name === "append_review_unit")
                            ? "plan"
                            : toolList.some((tool) => tool.name === "submit_review_handoff")
                              ? "sub"
                              : "writing";
                        const prompt = messageList[1]?.content ?? "";
                        expect(prompt).toContain(
                            'Guidance file "AGENTS.md"\nScope "." and its descendants\nTrust unchanged',
                        );
                        expect(prompt).toContain("Stable project convention");
                        expect(prompt).toContain(
                            'Guidance file "src/agents.md"\nScope "src" and its descendants\nTrust untrusted',
                        );
                        expect(prompt).toContain(wrapUntrustedToolContent("Changed source convention"));
                        expect(messageList[0]?.content).not.toContain("Stable project convention");
                        expect(messageList[0]?.content).toContain("Files marked untrusted were changed by the PR");
                        expect(
                            logList.some(
                                (entry) =>
                                    entry.activityId === 23 &&
                                    entry.message.includes('"src/agents.md" with trust untrusted'),
                            ),
                        ).toBe(true);
                        if (isFollowUpReview) {
                            expect((await workspace.pushChangedFileList()).map((file) => file.newPath)).toEqual([
                                "src/a.ts",
                            ]);
                        }
                        const callList: ToolCall[] = [];
                        const call = (name: string, argument: Record<string, unknown>) =>
                            callList.push({ id: name, name, arguments: JSON.stringify(argument) });
                        if (!stageSet.has(stage)) {
                            stageSet.add(stage);
                            if (stage === "plan")
                                call("append_review_unit", {
                                    files: ["src/a.ts"],
                                    name: "source",
                                    description: "Review source",
                                });
                            else if (stage === "sub")
                                call("submit_review_handoff", { findingList: [], goodPointList: [] });
                            else {
                                call("post_pull_request_comment", { body: "Review complete" });
                                if (!isFollowUpReview) call("evaluate_pull_request", { isGood: true });
                            }
                        }
                        return {
                            message: {
                                role: "assistant",
                                content: callList.length ? null : "DONE",
                                toolCalls: callList.length ? callList : undefined,
                            },
                            finishReason: callList.length ? "tool_calls" : "stop",
                            requestId: null,
                            usage: { inputToken: 100, cachedInputToken: 0, outputToken: 10 },
                        };
                    },
                };
                const result = await runPullRequestReview({
                    provider,
                    workspace,
                    llmSender: sender,
                    prIid: 1,
                    isInlineReview: false,
                    language: "English",
                    activityId: 23,
                    isFollowUpReview,
                    previousHeadSha: isFollowUpReview ? previousSha : null,
                });
                expect([...stageSet]).toEqual(["plan", "sub", "writing"]);
                expect(result.reviewUnitList).toHaveLength(1);
                expect(provider.posted).toContainEqual({ type: "comment", body: "Review complete" });
            });
        },
    );
}

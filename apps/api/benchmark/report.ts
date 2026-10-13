import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTPUT_DIR } from "./git.js";
import type { AttemptStatus, PhaseTiming, SenderStat, SubAgentMeasure } from "./measure.js";

export type AttemptRecord = {
    runId: string;
    caseId: string;
    project?: string;
    repeatIndex: number;
    attemptIndex: number;
    status: AttemptStatus;
    statusReason?: string | null;
    timing?: PhaseTiming;
    tokenUsage?: { inputToken: number; outputToken: number; cachedInputToken: number } | null;
    sender?: Partial<SenderStat> | null;
    reviewUnitCount?: number | null;
    subAgentList?: SubAgentMeasure[];
    changedFileCount?: number;
    addedLineCount?: number;
    deletedLineCount?: number;
    postedCommentCount?: number | null;
    postedInlineCount?: number | null;
    coverageMissList?: string[];
    startedAt?: string;
    finishedAt?: string | null;
    repro?: { manifestHash?: string };
};

type CaseInfo = Pick<AttemptRecord, "caseId" | "project" | "addedLineCount" | "deletedLineCount" | "changedFileCount">;

export type SizeBucket = "S" | "M" | "L" | "XL" | "BZ" | "unknown";

function isKnownCount(value: number | undefined): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** BZ holds binary only or zero text change cases, never filled by duplicating cases. */
export function sizeBucket(addedLineCount?: number, deletedLineCount?: number): SizeBucket {
    if (!isKnownCount(addedLineCount) || !isKnownCount(deletedLineCount)) return "unknown";
    const total = addedLineCount + deletedLineCount;
    if (total === 0) return "BZ";
    if (total <= 100) return "S";
    if (total <= 500) return "M";
    if (total <= 2000) return "L";
    return "XL";
}

export function median(valueList: number[]): number | null {
    if (valueList.length === 0) return null;
    const sorted = [...valueList].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export type CaseSummary = {
    caseId: string;
    project: string;
    bucket: SizeBucket;
    changedFileCount: number | null;
    attemptCount: number;
    statusCount: Record<string, number>;
    completedMsList: number[];
    medianReviewMs: number | null;
    minReviewMs: number | null;
    maxReviewMs: number | null;
    medianTiming: Partial<PhaseTiming>;
    medianInputToken: number | null;
    medianOutputToken: number | null;
    medianCachedInputToken: number | null;
    medianRequestCount: number | null;
    medianReviewUnitCount: number | null;
    medianOutputCount: number | null;
};

function countByStatus(recordList: AttemptRecord[]): Record<string, number> {
    const statusCount: Record<string, number> = {};
    for (const record of recordList) {
        statusCount[record.status] = (statusCount[record.status] ?? 0) + 1;
    }
    return statusCount;
}

function medianOf(
    recordList: AttemptRecord[],
    pick: (record: AttemptRecord) => number | null | undefined,
): number | null {
    return median(recordList.map(pick).filter((value): value is number => typeof value === "number"));
}

function summarizeCaseInfo(recordList: AttemptRecord[]): Pick<CaseSummary, "project" | "bucket" | "changedFileCount"> {
    const sizeRecord = recordList.find(
        (record) => sizeBucket(record.addedLineCount, record.deletedLineCount) !== "unknown",
    );
    return {
        project: recordList.find((record) => record.project?.trim())?.project ?? "unknown",
        bucket: sizeBucket(sizeRecord?.addedLineCount, sizeRecord?.deletedLineCount),
        changedFileCount: recordList.find((record) => isKnownCount(record.changedFileCount))?.changedFileCount ?? null,
    };
}

export function summarizeCase(recordList: AttemptRecord[]): CaseSummary {
    const first = recordList[0]!;
    const completedList = recordList.filter((record) => record.status === "completed");
    const completedMsList = completedList
        .map((record) => record.timing?.reviewMs)
        .filter((value): value is number => typeof value === "number");
    const medianTiming: Partial<PhaseTiming> = {};
    for (const key of ["setupMs", "planMs", "subWallMs", "writingMs", "finalizeMs"] as const) {
        const value = medianOf(completedList, (record) => record.timing?.[key]);
        if (value !== null) medianTiming[key] = value;
    }
    return {
        caseId: first.caseId,
        ...summarizeCaseInfo(recordList),
        attemptCount: recordList.length,
        statusCount: countByStatus(recordList),
        completedMsList,
        medianReviewMs: median(completedMsList),
        minReviewMs: completedMsList.length ? Math.min(...completedMsList) : null,
        maxReviewMs: completedMsList.length ? Math.max(...completedMsList) : null,
        medianTiming,
        medianInputToken: medianOf(
            completedList,
            (record) => record.sender?.inputToken ?? record.tokenUsage?.inputToken,
        ),
        medianOutputToken: medianOf(
            completedList,
            (record) => record.sender?.outputToken ?? record.tokenUsage?.outputToken,
        ),
        medianCachedInputToken: medianOf(
            completedList,
            (record) => record.sender?.cachedInputToken ?? record.tokenUsage?.cachedInputToken,
        ),
        medianRequestCount: medianOf(completedList, (record) => record.sender?.requestCount),
        medianReviewUnitCount: medianOf(completedList, (record) => record.reviewUnitCount),
        medianOutputCount: medianOf(completedList, (record) =>
            typeof record.postedCommentCount === "number" && typeof record.postedInlineCount === "number"
                ? record.postedCommentCount + record.postedInlineCount
                : null,
        ),
    };
}

export function summarizeBatch(recordList: AttemptRecord[]): CaseSummary[] {
    const byCaseMap = new Map<string, AttemptRecord[]>();
    for (const record of recordList) {
        const list = byCaseMap.get(record.caseId) ?? [];
        list.push(record);
        byCaseMap.set(record.caseId, list);
    }
    return [...byCaseMap.values()]
        .map(summarizeCase)
        .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
}

export type GroupSummary = {
    project: string;
    bucket: SizeBucket;
    caseCount: number;
    completedCaseCount: number;
    statusCount: Record<string, number>;
    medianChangedFileCount: number | null;
    medianOfCaseMedianMs: number | null;
    minCaseMedianMs: number | null;
    maxCaseMedianMs: number | null;
};

export function summarizeGroupList(caseSummaryList: CaseSummary[]): GroupSummary[] {
    const byGroupMap = new Map<string, CaseSummary[]>();
    for (const summary of caseSummaryList) {
        const key = `${summary.project}|${summary.bucket}`;
        const list = byGroupMap.get(key) ?? [];
        list.push(summary);
        byGroupMap.set(key, list);
    }
    const groupList: GroupSummary[] = [];
    for (const [key, list] of byGroupMap) {
        const [project, bucket] = key.split("|") as [string, SizeBucket];
        const caseMedianList = list
            .map((summary) => summary.medianReviewMs)
            .filter((value): value is number => typeof value === "number");
        const statusCount: Record<string, number> = {};
        for (const summary of list) {
            for (const [status, count] of Object.entries(summary.statusCount)) {
                statusCount[status] = (statusCount[status] ?? 0) + count;
            }
        }
        groupList.push({
            project,
            bucket,
            caseCount: list.length,
            completedCaseCount: list.filter((summary) => summary.medianReviewMs !== null).length,
            statusCount,
            medianChangedFileCount: median(
                list.map((summary) => summary.changedFileCount).filter((value): value is number => value !== null),
            ),
            medianOfCaseMedianMs: median(caseMedianList),
            minCaseMedianMs: caseMedianList.length ? Math.min(...caseMedianList) : null,
            maxCaseMedianMs: caseMedianList.length ? Math.max(...caseMedianList) : null,
        });
    }
    return groupList.sort((a, b) =>
        a.project === b.project ? (a.bucket < b.bucket ? -1 : 1) : a.project < b.project ? -1 : 1,
    );
}

export type CompareRow = {
    caseId: string;
    project: string;
    bucket: SizeBucket;
    pairCount: number;
    baselineMedianMs: number;
    candidateMedianMs: number;
    relativeChange: number;
};

export type CompareResult = {
    rowList: CompareRow[];
    /** Cases without enough completed pairs, kept visible instead of dropped silently. */
    unpairedList: { caseId: string; baselineStatus: Record<string, number>; candidateStatus: Record<string, number> }[];
    regressionList: { caseId: string; status: Record<string, number>; side: "baseline" | "candidate" }[];
    medianRelativeChange: number | null;
};

function assertSameManifest(hashList: unknown[]): void {
    if (hashList.some((hash) => typeof hash !== "string" || hash.trim().length === 0)) {
        throw new Error("Cannot compare because manifest identity is missing. Run a new batch with a frozen manifest.");
    }
    if (new Set(hashList).size > 1) {
        throw new Error("Cannot compare because the frozen manifest differs. Use batch input from the same manifest.");
    }
}

function comparisonManifestHashList(recordList: AttemptRecord[]): (string | undefined)[] {
    // An interrupted start event can lack repro data and contributes no timing.
    return recordList
        .filter((record) => record.status === "completed" || record.repro !== undefined)
        .map((record) => record.repro?.manifestHash);
}

/** Pair completed attempts only after checking frozen input identity. */
export function compareBatch(baselineList: AttemptRecord[], candidateList: AttemptRecord[]): CompareResult {
    assertSameManifest(comparisonManifestHashList([...baselineList, ...candidateList]));
    const caseIdSet = new Set([...baselineList.map((r) => r.caseId), ...candidateList.map((r) => r.caseId)]);
    const rowList: CompareRow[] = [];
    const unpairedList: CompareResult["unpairedList"] = [];
    const regressionList: CompareResult["regressionList"] = [];

    for (const caseId of [...caseIdSet].sort()) {
        const baseCaseList = baselineList.filter((record) => record.caseId === caseId);
        const candCaseList = candidateList.filter((record) => record.caseId === caseId);
        const pairMsList: { base: number; cand: number }[] = [];
        const repeatSet = new Set([
            ...baseCaseList.map((record) => record.repeatIndex),
            ...candCaseList.map((record) => record.repeatIndex),
        ]);
        for (const repeatIndex of repeatSet) {
            const base = baseCaseList.find(
                (record) => record.repeatIndex === repeatIndex && record.status === "completed",
            );
            const cand = candCaseList.find(
                (record) => record.repeatIndex === repeatIndex && record.status === "completed",
            );
            const baseMs = base?.timing?.reviewMs;
            const candMs = cand?.timing?.reviewMs;
            if (typeof baseMs === "number" && typeof candMs === "number") {
                pairMsList.push({ base: baseMs, cand: candMs });
            }
        }
        const caseInfo = summarizeCaseInfo([...candCaseList, ...baseCaseList]);
        for (const [side, list] of [
            ["baseline", baseCaseList],
            ["candidate", candCaseList],
        ] as const) {
            const badList = list.filter((record) => record.status !== "completed");
            if (badList.length > 0) {
                regressionList.push({ caseId, status: countByStatus(badList), side });
            }
        }
        if (pairMsList.length === 0) {
            unpairedList.push({
                caseId,
                baselineStatus: countByStatus(baseCaseList),
                candidateStatus: countByStatus(candCaseList),
            });
            continue;
        }
        const baselineMedianMs = median(pairMsList.map((pair) => pair.base))!;
        const candidateMedianMs = median(pairMsList.map((pair) => pair.cand))!;
        rowList.push({
            caseId,
            project: caseInfo.project,
            bucket: caseInfo.bucket,
            pairCount: pairMsList.length,
            baselineMedianMs,
            candidateMedianMs,
            relativeChange: baselineMedianMs === 0 ? 0 : (candidateMedianMs - baselineMedianMs) / baselineMedianMs,
        });
    }

    return {
        rowList,
        unpairedList,
        regressionList,
        medianRelativeChange: median(rowList.map((row) => row.relativeChange)),
    };
}

function formatMs(value: number | null): string {
    if (value === null) return "-";
    if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
    return `${(value / 1000).toFixed(1)}s`;
}

function formatCount(value: number | null): string {
    return value === null ? "-" : String(Math.round(value));
}

function formatStatus(statusCount: Record<string, number>): string {
    return Object.entries(statusCount)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([status, count]) => `${status}:${count}`)
        .join(" ");
}

function renderTable(headerList: string[], rowList: string[][]): string {
    const widthList = headerList.map((header, index) =>
        Math.max(header.length, ...rowList.map((row) => (row[index] ?? "").length)),
    );
    const line = (cellList: string[]) =>
        cellList
            .map((cell, index) => (cell ?? "").padEnd(widthList[index]!))
            .join("  ")
            .trimEnd();
    return [line(headerList), line(widthList.map((width) => "-".repeat(width))), ...rowList.map(line)].join("\n");
}

export function renderReportText(batchId: string, recordList: AttemptRecord[]): string {
    const caseSummaryList = summarizeBatch(recordList);
    const groupList = summarizeGroupList(caseSummaryList);
    const sectionList: string[] = [];
    sectionList.push(`# Benchmark report ${batchId}`);
    sectionList.push(`attempts ${recordList.length}  cases ${caseSummaryList.length}`);
    sectionList.push(
        `status total: ${formatStatus(
            recordList.reduce<Record<string, number>>((acc, record) => {
                acc[record.status] = (acc[record.status] ?? 0) + 1;
                return acc;
            }, {}),
        )}`,
    );

    sectionList.push("## Group summary (project x size)");
    sectionList.push(
        renderTable(
            ["project", "size", "cases", "done", "status", "files(med)", "reviewMs(med)", "range"],
            groupList.map((group) => [
                group.project,
                group.bucket,
                String(group.caseCount),
                String(group.completedCaseCount),
                formatStatus(group.statusCount),
                formatCount(group.medianChangedFileCount),
                formatMs(group.medianOfCaseMedianMs),
                `${formatMs(group.minCaseMedianMs)}..${formatMs(group.maxCaseMedianMs)}`,
            ]),
        ),
    );

    sectionList.push("## Case detail");
    sectionList.push(
        renderTable(
            [
                "case",
                "size",
                "files",
                "status",
                "reviewMs(med)",
                "range",
                "setup",
                "plan",
                "subWall",
                "writing",
                "inTok",
                "outTok",
                "cachedTok",
                "req",
                "units",
                "outputs",
            ],
            caseSummaryList.map((summary) => [
                summary.caseId,
                summary.bucket,
                formatCount(summary.changedFileCount),
                formatStatus(summary.statusCount),
                formatMs(summary.medianReviewMs),
                `${formatMs(summary.minReviewMs)}..${formatMs(summary.maxReviewMs)}`,
                formatMs(summary.medianTiming.setupMs ?? null),
                formatMs(summary.medianTiming.planMs ?? null),
                formatMs(summary.medianTiming.subWallMs ?? null),
                formatMs(summary.medianTiming.writingMs ?? null),
                formatCount(summary.medianInputToken),
                formatCount(summary.medianOutputToken),
                formatCount(summary.medianCachedInputToken),
                formatCount(summary.medianRequestCount),
                formatCount(summary.medianReviewUnitCount),
                formatCount(summary.medianOutputCount),
            ]),
        ),
    );
    return sectionList.join("\n\n");
}

export function renderCompareText(baselineId: string, candidateId: string, result: CompareResult): string {
    const sectionList: string[] = [];
    sectionList.push(`# Benchmark compare ${baselineId} -> ${candidateId}`);
    sectionList.push(
        result.rowList.length === 0
            ? "no completed case pairs to compare"
            : `paired cases ${result.rowList.length}  median relative change ${
                  result.medianRelativeChange === null ? "-" : `${(result.medianRelativeChange * 100).toFixed(1)}%`
              }`,
    );
    if (result.rowList.length > 0) {
        sectionList.push(
            renderTable(
                ["case", "size", "pairs", "baseline", "candidate", "change"],
                result.rowList.map((row) => [
                    row.caseId,
                    row.bucket,
                    String(row.pairCount),
                    formatMs(row.baselineMedianMs),
                    formatMs(row.candidateMedianMs),
                    `${(row.relativeChange * 100).toFixed(1)}%`,
                ]),
            ),
        );
    }
    if (result.regressionList.length > 0) {
        sectionList.push("## Non completed attempts (must be disclosed with any speed claim)");
        sectionList.push(
            renderTable(
                ["case", "side", "status"],
                result.regressionList.map((item) => [item.caseId, item.side, formatStatus(item.status)]),
            ),
        );
    }
    if (result.unpairedList.length > 0) {
        sectionList.push("## Cases without a completed pair");
        sectionList.push(
            renderTable(
                ["case", "baseline", "candidate"],
                result.unpairedList.map((item) => [
                    item.caseId,
                    formatStatus(item.baselineStatus),
                    formatStatus(item.candidateStatus),
                ]),
            ),
        );
    }
    return sectionList.join("\n\n");
}

export async function loadBatchRecordList(batchId: string): Promise<AttemptRecord[]> {
    const batchDir = join(OUTPUT_DIR, batchId);
    const [content, metaContent] = await Promise.all([
        readFile(join(batchDir, "result.jsonl"), "utf-8"),
        readFile(join(batchDir, "run.json"), "utf-8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "{}";
            throw error;
        }),
    ]);
    const meta = JSON.parse(metaContent) as { caseInfoList?: CaseInfo[] };
    const caseInfoById = new Map((meta.caseInfoList ?? []).map((info) => [info.caseId, info]));
    return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AttemptRecord & { type: string })
        .filter((line) => line.type === "result")
        .map((record) => {
            const info = caseInfoById.get(record.caseId);
            if (!info) return record;
            // Static case information comes from the batch snapshot, independent of attempt status.
            return {
                ...record,
                project: info.project,
                addedLineCount: info.addedLineCount,
                deletedLineCount: info.deletedLineCount,
                changedFileCount: info.changedFileCount,
            };
        });
}

export async function reportBatch(batchId: string): Promise<string> {
    const recordList = await loadBatchRecordList(batchId);
    const text = renderReportText(batchId, recordList);
    await writeFile(join(OUTPUT_DIR, batchId, "report.txt"), `${text}\n`);
    return text;
}

export async function compareBatchById(baselineId: string, candidateId: string): Promise<string> {
    const baselineMeta = JSON.parse(await readFile(join(OUTPUT_DIR, baselineId, "run.json"), "utf-8"));
    const candidateMeta = JSON.parse(await readFile(join(OUTPUT_DIR, candidateId, "run.json"), "utf-8"));
    const baselineList = await loadBatchRecordList(baselineId);
    const candidateList = await loadBatchRecordList(candidateId);
    assertSameManifest([
        baselineMeta.manifestHash,
        candidateMeta.manifestHash,
        ...comparisonManifestHashList([...baselineList, ...candidateList]),
    ]);
    const text = renderCompareText(baselineId, candidateId, compareBatch(baselineList, candidateList));
    await writeFile(join(OUTPUT_DIR, candidateId, `compare-${baselineId}.txt`), `${text}\n`);
    return text;
}

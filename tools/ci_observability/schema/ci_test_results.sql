-- CI observability — columnar store schema (FUG-128).
--
-- The BEP parser (tools/ci_observability/bep_report.py) emits one row per test
-- case (and one per failed build target). This table is the columnar backend
-- the dashboards aggregate over. It's plain ClickHouse DDL, so it applies to:
--
--   * Tinybird's free "Build" plan (managed ClickHouse) — the recommended
--     free, fully-hosted, well-supported option (ClickHouse Cloud is a trial).
--     Create it as a Data Source; see ci_test_results.datasource for the
--     Tinybird-native form.
--   * ClickHouse Cloud, or any self-hosted ClickHouse — run this verbatim.
--
-- The `sinks.push_clickhouse` adapter inserts with `INSERT INTO ci_test_results
-- FORMAT JSONEachRow`, so the column names below must match the Record fields.

CREATE TABLE IF NOT EXISTS ci_test_results
(
    -- When the invocation started (UTC).
    timestamp          DateTime64(3, 'UTC'),

    -- Invocation / VCS / CI context.
    invocation_id      LowCardinality(String),
    commit             String,
    branch             LowCardinality(String),
    pr                 String,
    workflow           LowCardinality(String),
    job                LowCardinality(String),
    run_url            String,

    -- Runner / DUT this ran on: github:linux, github:macos, hitl-rig-1:c6-abcdef.
    runner             LowCardinality(String),
    runner_os          LowCardinality(String),

    -- What ran.
    target             String,
    target_kind        LowCardinality(String),
    record_type        LowCardinality(String),  -- test_case | target
    test_suite         String,
    test_case          String,

    -- Outcome.
    status             LowCardinality(String),   -- PASSED|FAILED|TIMEOUT|ERROR|BUILD_FAILED|FLAKY|SKIPPED
    cached             UInt8,
    duration_ms        UInt32,
    attempt            UInt16,
    run                UInt16,
    shard              UInt16,

    -- Failure detail (empty for passes).
    failure_category   LowCardinality(String),   -- disk|memory|timeout|network|build|assertion|other
    failure_signature  String,                   -- scrubbed one-liner (groups identical failures)
    failure_reason     String,                   -- raw first line
    failure_trace      String                    -- full trace/log excerpt
)
ENGINE = MergeTree
-- Partition by month keeps parts manageable and lets old data be dropped by
-- TTL / DROP PARTITION cheaply.
PARTITION BY toYYYYMM(timestamp)
-- Order for the dashboards' access patterns: time-bounded scans, then by runner
-- and target (the "by runner/DUT" and "heatmap by test case" group-bys).
ORDER BY (toDate(timestamp), runner, target, test_case)
-- Free-tier friendly: keep 180 days, then age out.
TTL toDateTime(timestamp) + INTERVAL 180 DAY;

-- ---------------------------------------------------------------------------
-- Reference queries (the three views the dashboard renders):
--
-- 1) Failures aggregated by trace/reason:
--    SELECT failure_signature, count() AS n
--    FROM ci_test_results
--    WHERE status NOT IN ('PASSED','SKIPPED','FLAKY') AND timestamp > now() - INTERVAL 14 DAY
--    GROUP BY failure_signature ORDER BY n DESC LIMIT 25;
--
-- 2) Failures aggregated by runner / DUT (flaky hardware/runner detection):
--    SELECT runner, count() AS n
--    FROM ci_test_results
--    WHERE status NOT IN ('PASSED','SKIPPED') AND timestamp > now() - INTERVAL 14 DAY
--    GROUP BY runner ORDER BY n DESC;
--
-- 3) Heatmap of failures by test case over time:
--    SELECT toDate(timestamp) AS day, test_case, count() AS n
--    FROM ci_test_results
--    WHERE status NOT IN ('PASSED','SKIPPED') AND timestamp > now() - INTERVAL 30 DAY
--    GROUP BY day, test_case ORDER BY day;
-- ---------------------------------------------------------------------------

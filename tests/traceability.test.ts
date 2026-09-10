import { describe, expect, it } from "vitest";

/**
 * §11.2 traceability. The rows below are deliberately explicit: Week 1 MVP
 * does not pretend to implement controls that require external authority or
 * network isolation.
 */
const traceability = [
  { scenario: "隔離egress/DNS再解決、private IP、redirect、本文・timeout境界", implemented: false, futureTest: "isolated-egress-rebinding.test.ts: rejects_private_redirect_and_rebinding" },
  { scenario: "robots/規約拒否と443接続の実ネットワーク再取得", implemented: false, futureTest: "isolated-egress-rebinding.test.ts: rejects_policy_and_non443" },
  { scenario: "ドメイン管理者のDNS TXT/.well-known同意UI・異議の外部受付", implemented: false, futureTest: "audit-operations.test.ts: verifies_domain_control_and_records_objection" },
  { scenario: "独立監査の抽出・盲検再取得・counterevidence corroboration", implemented: false, futureTest: "audit-operations.test.ts: confirms_counterevidence_and_hold_release" },
  { scenario: "バックアップ7日上限と段階1の実データ37日物理消去証跡", implemented: false, futureTest: "retention-backup-gate.test.ts: proves_backup_erasure_before_stage2" },
  { scenario: "MCP Streamable HTTP、5ツール、分離schema/catalog、合成送信→集約→lookup", implemented: true, futureTest: "mcp.test.ts: publishes_five_tools_and_structured_outputs" },
  { scenario: "pg-mem migration 14表、transaction state、単一/multi batch、tombstone、冪等、TTL、rate/dedup/group上限", implemented: true, futureTest: "service.test.ts: migration_and_persistence_transaction" },
];

describe("§11.2 traceability", () => {
  it("records an honest implementation boundary and future test mapping", () => {
    expect(traceability).toEqual(expect.arrayContaining([
      expect.objectContaining({ scenario: "隔離egress/DNS再解決、private IP、redirect、本文・timeout境界", implemented: false }),
      expect.objectContaining({ scenario: "MCP Streamable HTTP、5ツール、分離schema/catalog、合成送信→集約→lookup", implemented: true }),
    ]));
    for (const row of traceability) expect(row.futureTest).toMatch(/\.test\.ts:/);
  });
});

export { traceability };

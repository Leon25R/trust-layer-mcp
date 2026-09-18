(() => {
  const status = document.getElementById('stats-status');
  const content = document.getElementById('stats-content');
  const acceptedObservations = document.getElementById('accepted-observations');
  const observedDomains = document.getElementById('observed-domains');
  const provenanceGroups = document.getElementById('provenance-groups');
  const recentActivity = document.getElementById('recent-activity');
  const coverageStartedAt = document.getElementById('coverage-started-at');
  const generatedAt = document.getElementById('generated-at');
  const limitations = document.getElementById('limitations');

  const bandLabels = {
    '0': '0件',
    '1-9': '1〜9件',
    '10-49': '10〜49件',
    '50-99': '50〜99件',
    '100+': '100件以上'
  };
  const activityLabels = {
    no_public_activity_yet: '公開活動はまだありません。',
    activity_within_7d: '7日以内に公開活動があります。',
    no_activity_within_7d: '直近7日以内の公開活動はありません。'
  };
  const limitationLabels = {
    aggregated_only: '個別データではなく、集計結果のみを表示しています。',
    no_domain_enumeration: '個別ドメインの一覧は表示していません。',
    not_a_truth_rating: '真実性や安全性の評価ではありません。',
    groups_do_not_prove_independence: '出所グループの数だけで、独立性が証明されるわけではありません。'
  };

  function requiredBand(metric) {
    if (!metric || typeof metric.display_range !== 'string' || !Object.hasOwn(bandLabels, metric.display_range)) throw new Error('invalid metric');
    return bandLabels[metric.display_range];
  }

  function requiredText(value) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('invalid text');
    return value;
  }

  function displayGeneratedAt(value) {
    const iso = requiredText(value);
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== iso) throw new Error('invalid timestamp');
    return iso.replace('T', ' ').replace(/\.000Z$/, ' UTC');
  }

  function renderStats(data) {
    if (!data || typeof data !== 'object' || !data.metrics || typeof data.metrics !== 'object') throw new Error('invalid stats');
    acceptedObservations.textContent = requiredBand(data.metrics.accepted_observations);
    observedDomains.textContent = requiredBand(data.metrics.observed_domains);
    provenanceGroups.textContent = requiredBand(data.metrics.provenance_groups);
    if (!Object.hasOwn(activityLabels, data.recent_activity)) throw new Error('invalid activity');
    recentActivity.textContent = activityLabels[data.recent_activity];
    coverageStartedAt.textContent = requiredText(data.coverage_started_at);
    generatedAt.textContent = displayGeneratedAt(data.generated_at);
    if (!Array.isArray(data.limitations)) throw new Error('invalid limitations');
    limitations.replaceChildren();
    data.limitations.forEach((limitation) => {
      if (typeof limitation !== 'string' || !Object.hasOwn(limitationLabels, limitation)) throw new Error('invalid limitation');
      const item = document.createElement('li');
      item.textContent = limitationLabels[limitation];
      limitations.appendChild(item);
    });
    content.hidden = false;
    status.className = 'status';
    status.textContent = '公開統計を表示しています。';
  }

  function showUnavailable() {
    content.hidden = true;
    status.className = 'status error';
    status.textContent = '現在、統計を一時的に取得できません。時間をおいて再度お試しください。';
  }

  async function loadStats() {
    try {
      const response = await fetch('/api/public/stats', { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('stats unavailable');
      renderStats(await response.json());
    } catch {
      showUnavailable();
    }
  }

  void loadStats();
})();

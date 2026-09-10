(() => {
      const form = document.getElementById('lookup-form');
      const input = document.getElementById('domain');
      const button = document.getElementById('lookup-button');
      const result = document.getElementById('result');
      const feedbackForm = document.getElementById('feedback-form');
      const feedbackResult = document.getElementById('feedback-result');

      function hostnameOnly(value) {
        const candidate = value.trim();
        if (!candidate) throw new Error('ドメインを入力してください。');
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : 'https://' + candidate;
        const parsed = new URL(withScheme);
        if (!parsed.hostname || parsed.username || parsed.password) throw new Error('公開ドメイン形式で入力してください。');
        return parsed.hostname;
      }

      function text(value) { return document.createTextNode(value); }
      function showMessage(title, message, isError) {
        result.hidden = false;
        result.className = 'status' + (isError ? ' error' : '');
        result.replaceChildren();
        const heading = document.createElement('h2');
        heading.appendChild(text(title));
        const paragraph = document.createElement('p');
        paragraph.appendChild(text(message));
        result.append(heading, paragraph);
      }

      function renderResponse(response) {
        result.hidden = false;
        result.className = 'status';
        result.replaceChildren();
        const heading = document.createElement('h2');
        const messages = {
          no_public_observations: '公開できる共有観測はありません',
          limited_observations: '共有観測はまだ判断材料が限られています',
          under_review: '公開シグナルは確認中です',
          withdrawn: '公開シグナルは撤回されています'
        };
        heading.appendChild(text(messages[response.publication_status] || '公開結果'));
        const intro = document.createElement('p');
        intro.appendChild(text('対象: ' + response.domain + '。これは真実性や安全性の評価ではありません。'));
        result.append(heading, intro);
        const checks = document.createElement('p');
        checks.appendChild(text('次に確認すること: 著者・運営元、確認日、主張を直接支える一次資料。'));
        result.appendChild(checks);
        if (response.source_routes.length) {
          const title = document.createElement('p');
          title.appendChild(text('運営者が確認した参照先'));
          result.appendChild(title);
          response.source_routes.forEach((route) => {
            const item = document.createElement('div');
            item.className = 'route';
            const official = document.createElement('a');
            official.href = route.official_source_url;
            official.rel = 'noreferrer';
            official.textContent = '公式資料入口';
            const updates = document.createElement('a');
            updates.href = route.update_history_url;
            updates.rel = 'noreferrer';
            updates.textContent = '更新履歴入口';
            item.append(official, text(' / '), updates);
            const scope = document.createElement('small');
            scope.appendChild(text('（確認日: ' + route.checked_on + '、適用範囲: ' + route.scope + '）'));
            item.appendChild(document.createElement('br'));
            item.appendChild(scope);
            result.appendChild(item);
          });
        }
      }

      button.addEventListener('click', async (event) => {
        event.preventDefault();
        let hostname;
        try { hostname = hostnameOnly(input.value); } catch (error) { showMessage('入力を確認してください', error.message, true); return; }
        button.disabled = true;
        showMessage('読み込み中', '公開情報を確認しています。', false);
        try {
          const response = await fetch('/api/public/domain-signal?domain=' + encodeURIComponent(hostname), { credentials: 'omit', cache: 'no-store' });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error === 'rate_limited' ? 'アクセスが集中しています。少し待ってから再試行してください。' : body.error === 'service_unavailable' ? '現在、一時的に利用できません。' : '入力または通信を確認してください。');
          renderResponse(body);
        } catch (error) { showMessage('読み込みできませんでした', error.message, true); }
        finally { button.disabled = false; }
      });

      document.getElementById('feedback-button').addEventListener('click', async (event) => {
        event.preventDefault();
        const payload = { category: document.getElementById('feedback-category').value };
        const domain = document.getElementById('feedback-domain').value.trim();
        if (domain) {
          try { payload.domain = hostnameOnly(domain); } catch { feedbackResult.textContent = 'ドメイン形式を確認してください。'; return; }
        }
        try {
          const response = await fetch('/api/public/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', cache: 'no-store', body: JSON.stringify(payload) });
          feedbackResult.textContent = response.ok ? '送信しました。ありがとうございます。' : response.status === 429 ? '本日の受付上限に達しました。' : '送信できませんでした。';
        } catch { feedbackResult.textContent = '送信できませんでした。'; }
      });
    })();

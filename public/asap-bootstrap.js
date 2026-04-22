(async function () {
	const script = document.currentScript;
	const bridgeOrigin = script?.src ? new URL(script.src).origin : window.location.origin;
	const scriptContext = script?.dataset || {};
	const windowContext = window.ZBT_SUPPORT_CONTEXT || {};
	const zohoAsapScriptUrl = `${bridgeOrigin}/zoho-asap.js`;
	if (!zohoAsapScriptUrl) return;
	const upmindJwt = scriptContext.upmindJwt || windowContext.upmindJwt || windowContext.user_token || windowContext.userToken;
	const tokenKeys = window.ZBT_UPMIND_TOKEN_KEYS || [
		'access_token',
		'upmind_access_token',
		'upmind.auth.token',
		'auth._token.local',
		'auth.token'
	];
	const upmindClient = {
		clientId: scriptContext.clientId || windowContext.clientId || windowContext.client_id || windowContext.uid,
		email: scriptContext.email || windowContext.email,
		name: scriptContext.name || windowContext.name,
		issued: Number(scriptContext.issued || windowContext.issued || Date.now())
	};
	const authQuery = upmindJwt ? `?user_token=${encodeURIComponent(upmindJwt)}` : '';
	const upmindAccessToken = readTokenFromStorage();
	const authHeaders = upmindAccessToken ? { authorization: `Bearer ${upmindAccessToken}` } : {};
	const fetchJson = (path) => fetch(`${bridgeOrigin}${path}`, { credentials: 'include', headers: authHeaders }).then(r => r.json());
	const postJson = (path, body) => fetch(`${bridgeOrigin}${path}`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	}).then(r => r.json());
	const hasClientHandoff = Boolean(upmindClient.clientId && upmindClient.email);
	await loadZohoAsap();

	const ctx = await (hasClientHandoff
		? postJson('/auth/upmind-api-client-context', upmindClient)
		: fetchJson(`/auth/upmind-client-context${authQuery}`)
	).catch(() => null);
	if (!ctx?.authenticated) return;

	let used = false;
	const getJwtTokenCallback = async (success, failure) => {
		try {
			const data = hasClientHandoff
				? await postJson('/auth/asap-jwt', upmindClient)
				: await fetchJson(`/auth/asap-jwt${authQuery}`);
			if (!data?.token) throw new Error('Missing token');
			success(data.token);
		} catch (err) {
			failure(err);
		}
	};

	if (!window.ZohoDeskAsapReady || !window.ZohoDeskAsap) return;

	window.ZohoDeskAsapReady(() => {
		if (used) return;
		used = true;
		ZohoDeskAsap.invoke('login', getJwtTokenCallback);
	});

	function loadZohoAsap() {
		if (document.getElementById('zohodeskasapscript')) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const s = document.createElement('script');
			s.type = 'text/javascript';
			s.id = 'zohodeskasapscript';
			s.defer = true;
			s.src = zohoAsapScriptUrl;
			s.onload = resolve;
			s.onerror = reject;
			const t = document.getElementsByTagName('script')[0] || document.head.firstChild;
			(t?.parentNode || document.head).insertBefore(s, t || null);
		});
	}

	function readTokenFromStorage() {
		for (const storage of [window.localStorage, window.sessionStorage]) {
			try {
				for (const key of tokenKeys) {
					const token = extractToken(storage.getItem(key));
					if (token) return token;
				}
				for (let i = 0; i < storage.length; i++) {
					const key = storage.key(i);
					const token = key ? extractToken(storage.getItem(key)) : null;
					if (token) return token;
				}
			} catch {
				// Storage can be blocked by browser privacy settings.
			}
		}
		return null;
	}

	function extractToken(value) {
		if (!value) return null;
		if (value.startsWith('Bearer ')) return value.slice(7);
		if (/^[A-Za-z0-9._~+/-]{20,}$/.test(value)) return value;
		try {
			const parsed = JSON.parse(value);
			const token = parsed && (parsed.access_token || parsed.accessToken || parsed.token || parsed.id_token);
			return typeof token === 'string' ? token.replace(/^Bearer\s+/i, '') : null;
		} catch {
			return null;
		}
	}
})();

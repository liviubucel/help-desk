(async function () {
	const script = document.currentScript;
	const bridgeOrigin = script?.src ? new URL(script.src).origin : window.location.origin;
	const scriptContext = script?.dataset || {};
	const windowContext = window.ZBT_SUPPORT_CONTEXT || {};
	const upmindJwt = scriptContext.upmindJwt || windowContext.upmindJwt || windowContext.user_token || windowContext.userToken;
	const upmindClient = {
		clientId: scriptContext.clientId || windowContext.clientId || windowContext.client_id || windowContext.uid,
		email: scriptContext.email || windowContext.email,
		name: scriptContext.name || windowContext.name,
		issued: Number(scriptContext.issued || windowContext.issued || Date.now())
	};
	const authQuery = upmindJwt ? `?user_token=${encodeURIComponent(upmindJwt)}` : '';
	const fetchJson = (path) => fetch(`${bridgeOrigin}${path}`, { credentials: 'include' }).then(r => r.json());
	const postJson = (path, body) => fetch(`${bridgeOrigin}${path}`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	}).then(r => r.json());
	const hasClientHandoff = Boolean(upmindClient.clientId && upmindClient.email);
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

	window.ZohoDeskAsapReady(() => {
		if (used) return;
		used = true;
		ZohoDeskAsap.invoke('login', getJwtTokenCallback);
	});
})();

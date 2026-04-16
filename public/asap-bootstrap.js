(async function () {
	const script = document.currentScript;
	const bridgeOrigin = script?.src ? new URL(script.src).origin : window.location.origin;
	const fetchJson = (path) => fetch(`${bridgeOrigin}${path}`, { credentials: 'include' }).then(r => r.json());
	const ctx = await fetchJson('/auth/upmind-client-context').catch(() => null);
	if (!ctx?.authenticated) return;

	let used = false;
	const getJwtTokenCallback = async (success, failure) => {
		try {
			const data = await fetchJson('/auth/asap-jwt');
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

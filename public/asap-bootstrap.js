(async function () {
	const ctx = await fetch('/auth/upmind-client-context', { credentials: 'include' }).then(r => r.json()).catch(() => null);
	if (!ctx?.authenticated) return;

	let used = false;
	const getJwtTokenCallback = async (success, failure) => {
		try {
			const data = await fetch('/auth/asap-jwt', { credentials: 'include' }).then(r => r.json());
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

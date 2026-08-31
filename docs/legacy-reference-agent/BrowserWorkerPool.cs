using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Playwright;

namespace SsoGeminiLogin.Agent;

internal sealed class BrowserWorkerPool : IAsyncDisposable
{
	private static readonly string[] EdgeArguments = ["--no-first-run", "--no-default-browser-check", "--disable-sync"];

	private static readonly string[] EmailOrPasswordSelectors = ["#identifierId", "input[name=\"Passwd\"]"];

	private static readonly string[] PasswordSelectors = ["input[name=\"Passwd\"]"];

	private sealed class BrowserWorker
	{
		private readonly object _gate = new object();

		private readonly List<AgentProgress> _progress = new List<AgentProgress>();

		private string _status = "starting";

		private string _message = "กำล\u0e31งสร\u0e49าง Secure Browser...";

		private DateTimeOffset _lastActivityAt = DateTimeOffset.UtcNow;

		private IBrowserContext? _context;

		private IPage? _page;

		private bool _accountVerified;

		private string? _verifiedUrl;

		public string User { get; }

		public string AccountId { get; }

		public string AccountEmail { get; }

		public string ProfileDirectory { get; }

		public DateTimeOffset CreatedAt { get; }

		public CancellationTokenSource LifetimeCancellation { get; } = new CancellationTokenSource();

		public CancellationTokenSource IdleCancellation { get; } = new CancellationTokenSource();

		public Task? LaunchTask { get; set; }

		public Task? IdleTask { get; set; }

		public int? VisibleProcessId { get; set; }

		public string CurrentStatus
		{
			get
			{
				lock (_gate)
				{
					return _status;
				}
			}
		}

		public DateTimeOffset LastActivityAt
		{
			get
			{
				lock (_gate)
				{
					return _lastActivityAt;
				}
			}
		}

		public IPage? Page
		{
			get
			{
				lock (_gate)
				{
					return _page;
				}
			}
		}

		public bool AccountVerified
		{
			get
			{
				lock (_gate)
				{
					return _accountVerified;
				}
			}
		}

		public string? VerifiedUrl
		{
			get
			{
				lock (_gate)
				{
					return _verifiedUrl;
				}
			}
		}

		public BrowserWorker(string user, string accountId, string accountEmail, string profileDirectory)
		{
			User = user;
			AccountId = accountId;
			AccountEmail = accountEmail;
			ProfileDirectory = profileDirectory;
			CreatedAt = DateTimeOffset.UtcNow;
			_progress.Add(new AgentProgress("starting", "สร\u0e49าง browser worker และจอง mapped account", CreatedAt));
		}

		public void Touch()
		{
			lock (_gate)
			{
				_lastActivityAt = DateTimeOffset.UtcNow;
			}
		}

		public void Record(string status, string message)
		{
			lock (_gate)
			{
				_status = status;
				_message = message;
				_progress.Add(new AgentProgress(status, message, DateTimeOffset.UtcNow));
			}
		}

		public void MarkAccountVerified(string verifiedUrl)
		{
			lock (_gate)
			{
				_accountVerified = true;
				_verifiedUrl = verifiedUrl;
			}
		}

		public bool TryBeginHandoff()
		{
			lock (_gate)
			{
				if (_status != "ready")
				{
					return false;
				}
				_status = "handing-off";
				_message = "กำล\u0e31งเป\u0e34ด Gemini ใน Microsoft Edge หน\u0e49าจร\u0e34ง...";
				_progress.Add(new AgentProgress(_status, _message, DateTimeOffset.UtcNow));
				return true;
			}
		}

		public void AttachContext(IBrowserContext context)
		{
			lock (_gate)
			{
				_context = context;
			}
		}

		public void AttachPage(IPage page)
		{
			lock (_gate)
			{
				_page = page;
			}
		}

		public IBrowserContext? DetachContext()
		{
			lock (_gate)
			{
				IBrowserContext? context = _context;
				_context = null;
				_page = null;
				return context;
			}
		}

		public void CancelLifetime()
		{
			if (!LifetimeCancellation.IsCancellationRequested)
			{
				LifetimeCancellation.Cancel();
			}
		}

		public void CancelIdleCleanup()
		{
			if (!IdleCancellation.IsCancellationRequested)
			{
				IdleCancellation.Cancel();
			}
		}

		public AgentStatus Snapshot(bool touch)
		{
			lock (_gate)
			{
				if (touch)
				{
					_lastActivityAt = DateTimeOffset.UtcNow;
				}
				return new AgentStatus(_status, _message, AccountEmail, CreatedAt, new AgentViewport(1440, 900), _progress.TakeLast(20).ToArray(), _accountVerified);
			}
		}
	}

	private const string GeminiUrl = "https://gemini.google.com/app";

	private const string GoogleLoginUrl = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&followup=https%3A%2F%2Fgemini.google.com%2Fapp";

	private static readonly HashSet<string> AllowedKeys = new HashSet<string>(StringComparer.Ordinal)
	{
		"Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home",
		"End", "PageUp", "PageDown"
	};

	private static readonly JsonSerializerOptions EvidenceJsonOptions = new JsonSerializerOptions
	{
		WriteIndented = true
	};

	private readonly object _gate = new object();

	private readonly AgentSettings _settings;

	private readonly AgentAccount _account;

	private readonly WindowsCredential _credential;

	private readonly ConcurrentDictionary<string, BrowserWorker> _workers = new ConcurrentDictionary<string, BrowserWorker>(StringComparer.OrdinalIgnoreCase);

	private readonly Dictionary<string, string> _accountLeases = new Dictionary<string, string>(StringComparer.Ordinal);

	private Task<IPlaywright>? _playwrightTask;

	public BrowserWorkerPool(AgentSettings settings, AgentAccount account, WindowsCredential credential)
	{
		_settings = settings;
		_account = account;
		_credential = credential;
	}

	public AgentStatus Start(string user, string accountId)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(user, nameof(user));
		ArgumentException.ThrowIfNullOrWhiteSpace(accountId, nameof(accountId));
		if (!string.Equals(accountId, _account.Id, StringComparison.Ordinal))
		{
			throw new InvalidOperationException("Unknown account reference.");
		}
		lock (_gate)
		{
			if (_workers.TryGetValue(user, out var value))
			{
				return value.Snapshot(touch: true);
			}
			if (_accountLeases.TryGetValue(accountId, out var value2) && !string.Equals(value2, user, StringComparison.OrdinalIgnoreCase))
			{
				throw new InvalidOperationException("บ\u0e31ญช\u0e35น\u0e35\u0e49กำล\u0e31งถ\u0e39กใช\u0e49งานโดย session อ\u0e37\u0e48น");
			}
			if (_workers.Count >= _settings.MaxWorkers)
			{
				throw new InvalidOperationException("Browser worker เต\u0e47ม กร\u0e38ณารอให\u0e49 session อ\u0e37\u0e48นส\u0e34\u0e49นส\u0e38ด");
			}
			BrowserWorker browserWorker = new BrowserWorker(user, accountId, _account.Email, Path.Combine(_settings.ProfileRoot, accountId));
			_workers[user] = browserWorker;
			_accountLeases[accountId] = user;
			browserWorker.LaunchTask = LaunchAsync(browserWorker, browserWorker.LifetimeCancellation.Token);
			return browserWorker.Snapshot(touch: true);
		}
	}

	public AgentStatus Status(string user)
	{
		if (!_workers.TryGetValue(user, out var value))
		{
			return new AgentStatus("not-started");
		}
		return value.Snapshot(touch: true);
	}

	public AgentMetrics Metrics()
	{
		return new AgentMetrics(_workers.Count, _settings.MaxWorkers, _accountLeases.Count);
	}

	public async Task<byte[]?> FrameAsync(string user)
	{
		if (!_workers.TryGetValue(user, out var value) || value.CurrentStatus != "ready" || value.Page == null)
		{
			return null;
		}
		value.Touch();
		return await value.Page.ScreenshotAsync(new PageScreenshotOptions
		{
			Type = ScreenshotType.Jpeg,
			Quality = 72,
			Animations = ScreenshotAnimations.Disabled
		}).ConfigureAwait(continueOnCapturedContext: false);
	}

	public async Task<bool> InputAsync(string user, AgentInput input)
	{
		if (!_workers.TryGetValue(user, out var value) || value.CurrentStatus != "ready" || value.Page == null)
		{
			return false;
		}
		value.Touch();
		IPage page = value.Page;
		switch (input.Type)
		{
		case "click":
			await page.Mouse.ClickAsync(Clamp(input.X, 0.0, 1440.0), Clamp(input.Y, 0.0, 900.0)).ConfigureAwait(continueOnCapturedContext: false);
			return true;
		case "move":
			await page.Mouse.MoveAsync(Clamp(input.X, 0.0, 1440.0), Clamp(input.Y, 0.0, 900.0)).ConfigureAwait(continueOnCapturedContext: false);
			return true;
		case "wheel":
			await page.Mouse.WheelAsync(0f, Clamp(input.DeltaY, -1200.0, 1200.0)).ConfigureAwait(continueOnCapturedContext: false);
			return true;
		case "text":
			if (input.Text != null)
			{
				await page.Keyboard.InsertTextAsync(input.Text.Substring(0, Math.Min(input.Text.Length, 4000))).ConfigureAwait(continueOnCapturedContext: false);
				return true;
			}
			break;
		case "key":
			if (input.Key != null && AllowedKeys.Contains(input.Key))
			{
				await page.Keyboard.PressAsync(input.Key).ConfigureAwait(continueOnCapturedContext: false);
				return true;
			}
			break;
		}
		return false;
	}

	public async Task<AgentStatus> HandoffAsync(string user, CancellationToken cancellationToken)
	{
		if (!_workers.TryGetValue(user, out var worker))
		{
			return new AgentStatus("not-started");
		}
		if (!worker.TryBeginHandoff())
		{
			AgentStatus agentStatus = worker.Snapshot(touch: true);
			string status = agentStatus.Status;
			if ((status == "handing-off" || status == "handed-off") ? true : false)
			{
				return agentStatus;
			}
			throw new InvalidOperationException("Gemini session is not ready for browser handoff.");
		}
		await (worker.DetachContext() ?? throw new InvalidOperationException("Secure Browser context is unavailable.")).CloseAsync().ConfigureAwait(continueOnCapturedContext: false);
		cancellationToken.ThrowIfCancellationRequested();
		ProcessStartInfo processStartInfo = new ProcessStartInfo
		{
			FileName = _settings.EdgeExecutable,
			UseShellExecute = true,
			CreateNoWindow = false
		};
		processStartInfo.ArgumentList.Add("--user-data-dir=" + worker.ProfileDirectory);
		processStartInfo.ArgumentList.Add("--profile-directory=Default");
		processStartInfo.ArgumentList.Add("--no-first-run");
		processStartInfo.ArgumentList.Add("--no-default-browser-check");
		processStartInfo.ArgumentList.Add("--new-window");
		processStartInfo.ArgumentList.Add("https://gemini.google.com/app");
		using Process process = Process.Start(processStartInfo) ?? throw new InvalidOperationException("Microsoft Edge could not be started.");
		worker.VisibleProcessId = process.Id;
		worker.CancelIdleCleanup();
		worker.Record("handed-off", "เป\u0e34ด Gemini ใน Microsoft Edge หน\u0e49าจร\u0e34งแล\u0e49ว");
		await WriteRealEvidenceAsync(worker, worker.VerifiedUrl ?? throw new InvalidOperationException("Verified Gemini URL is unavailable."), "handed-off", captureScreenshot: false).ConfigureAwait(continueOnCapturedContext: false);
		return worker.Snapshot(touch: true);
	}

	public async Task EndAsync(string user)
	{
		BrowserWorker? value;
		lock (_gate)
		{
			if (!_workers.TryRemove(user, out value))
			{
				return;
			}
			_accountLeases.Remove(value.AccountId);
		}
		value.CancelLifetime();
		value.CancelIdleCleanup();
		IBrowserContext? browserContext = value.DetachContext();
		if (browserContext != null)
		{
			await browserContext.CloseAsync().ConfigureAwait(continueOnCapturedContext: false);
		}
	}

	public async ValueTask DisposeAsync()
	{
		List<Task> backgroundTaskList = [];
		foreach (BrowserWorker worker in _workers.Values)
		{
			if (worker.LaunchTask is not null)
			{
				backgroundTaskList.Add(worker.LaunchTask);
			}
			if (worker.IdleTask is not null)
			{
				backgroundTaskList.Add(worker.IdleTask);
			}
		}
		Task[] backgroundTasks = backgroundTaskList.ToArray();
		string[] array = _workers.Keys.ToArray();
		foreach (string user in array)
		{
			await EndAsync(user).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (backgroundTasks.Length != 0)
		{
			await Task.WhenAll(backgroundTasks).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (_playwrightTask != null)
		{
			(await _playwrightTask.ConfigureAwait(continueOnCapturedContext: false)).Dispose();
		}
	}

	private async Task LaunchAsync(BrowserWorker worker, CancellationToken cancellationToken)
	{
		try
		{
			worker.Record("launching-edge", "กำล\u0e31งเป\u0e34ด Edge แบบ isolated profile...");
			Directory.CreateDirectory(worker.ProfileDirectory);
			IBrowserContext context = await LaunchPersistentContextWithRetryAsync(await GetPlaywrightAsync().ConfigureAwait(continueOnCapturedContext: false), worker.ProfileDirectory, cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
			if (cancellationToken.IsCancellationRequested)
			{
				await context.CloseAsync().ConfigureAwait(continueOnCapturedContext: false);
				return;
			}
			worker.AttachContext(context);
			IPage page = ((context.Pages.Count <= 0) ? (await context.NewPageAsync().ConfigureAwait(continueOnCapturedContext: false)) : context.Pages[0]);
			IPage page2 = page;
			worker.AttachPage(page2);
			context.Page += async delegate(object? _, IPage openedPage)
			{
				if (openedPage != worker.Page)
				{
					await openedPage.CloseAsync().ConfigureAwait(continueOnCapturedContext: false);
				}
			};
			worker.Record("navigating-google", "เป\u0e34ดหน\u0e49า Google Sign-In แล\u0e49ว...");
			await SignInAsync(worker, cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
			cancellationToken.ThrowIfCancellationRequested();
			page2.FrameNavigated += async delegate(object? _, IFrame frame)
			{
				if (frame != page2.MainFrame || worker.CurrentStatus != "ready" || IsGeminiUrl(frame.Url))
				{
					return;
				}
				worker.Record("returning", "กำล\u0e31งกล\u0e31บไป Gemini...");
				try
				{
					await page2.GotoAsync("https://gemini.google.com/app", new PageGotoOptions
					{
						WaitUntil = WaitUntilState.DOMContentLoaded
					}).ConfigureAwait(continueOnCapturedContext: false);
					worker.Record("ready", "Gemini พร\u0e49อมใช\u0e49งาน");
				}
				catch (PlaywrightException ex4)
				{
					Console.Error.WriteLine("Could not return to Gemini: " + ex4.Message);
				}
			};
			worker.Record("ready", "Gemini พร\u0e49อมใช\u0e49งาน");
			worker.IdleTask = IdleCleanupAsync(worker);
		}
		catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
		{
		}
		catch (Exception ex2)
		{
			Console.Error.WriteLine("Secure Browser launch failed: " + ex2.Message);
			IBrowserContext? browserContext = worker.DetachContext();
			if (browserContext != null)
			{
				try
				{
					await browserContext.CloseAsync().ConfigureAwait(continueOnCapturedContext: false);
				}
				catch (PlaywrightException ex3)
				{
					Console.Error.WriteLine("Secure Browser cleanup failed: " + ex3.Message);
				}
			}
			worker.Record("error", PublicLaunchError(ex2));
		}
	}

	private async Task<IBrowserContext> LaunchPersistentContextWithRetryAsync(IPlaywright playwright, string profileDirectory, CancellationToken cancellationToken)
	{
		for (int attempt = 1; attempt <= 5; attempt++)
		{
			try
			{
				return await playwright.Chromium.LaunchPersistentContextAsync(profileDirectory, new BrowserTypeLaunchPersistentContextOptions
				{
					ExecutablePath = _settings.EdgeExecutable,
					Headless = _settings.Headless,
					ViewportSize = new ViewportSize
					{
						Width = 1440,
						Height = 900
					},
					Locale = "th-TH",
					Args = EdgeArguments
				}).ConfigureAwait(continueOnCapturedContext: false);
			}
			catch (PlaywrightException ex) when (attempt < 5)
			{
				Console.Error.WriteLine($"Secure Browser launch attempt {attempt} failed; retrying: {ex.Message}");
				await Task.Delay(TimeSpan.FromMilliseconds(750 * attempt), cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
			}
		}
		throw new InvalidOperationException("Secure Browser launch retry loop ended unexpectedly.");
	}

	private async Task SignInAsync(BrowserWorker worker, CancellationToken cancellationToken)
	{
		IPage page = worker.Page ?? throw new InvalidOperationException("Browser page is unavailable.");
		await page.GotoAsync("https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&followup=https%3A%2F%2Fgemini.google.com%2Fapp", new PageGotoOptions
		{
			WaitUntil = WaitUntilState.DOMContentLoaded,
			Timeout = 60000f
		}).ConfigureAwait(continueOnCapturedContext: false);
		if (IsGeminiUrl(page.Url))
		{
			await VerifyGeminiAccountAsync(page, _account.Email, cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
			worker.MarkAccountVerified(page.Url);
			await WriteRealEvidenceAsync(worker, page.Url, "ready", captureScreenshot: true).ConfigureAwait(continueOnCapturedContext: false);
			worker.Record("session-reused", "พบ Google session เด\u0e34มใน isolated profile");
			return;
		}
		if (await WaitForEitherAsync(page, EmailOrPasswordSelectors, TimeSpan.FromSeconds(20L), cancellationToken).ConfigureAwait(continueOnCapturedContext: false) == "#identifierId")
		{
			worker.Record("entering-email", "กำล\u0e31งส\u0e48ง mapped Google email...");
			await page.Locator("#identifierId").FillAsync(_account.Email).ConfigureAwait(continueOnCapturedContext: false);
			await page.Locator("#identifierNext").ClickAsync().ConfigureAwait(continueOnCapturedContext: false);
		}
		worker.Record("entering-password", "กำล\u0e31งส\u0e48ง password จาก Windows Credential Manager...");
		string? text = await WaitForEitherAsync(page, PasswordSelectors, TimeSpan.FromSeconds(30L), cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
		if (text == null)
		{
			if (!IsGeminiUrl(page.Url))
			{
				throw new InvalidOperationException("Google sign-in did not present a supported password step.");
			}
			await VerifyGeminiAccountAsync(page, _account.Email, cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
			worker.MarkAccountVerified(page.Url);
			await WriteRealEvidenceAsync(worker, page.Url, "ready", captureScreenshot: true).ConfigureAwait(continueOnCapturedContext: false);
		}
		else
		{
			await page.Locator(text).FillAsync(_credential.Password).ConfigureAwait(continueOnCapturedContext: false);
			await page.Locator("#passwordNext").ClickAsync().ConfigureAwait(continueOnCapturedContext: false);
			worker.Record("waiting-google", "รอ Google ย\u0e37นย\u0e31นและสร\u0e49าง session...");
			await WaitForGeminiAsync(page, TimeSpan.FromSeconds(90L), cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
			await VerifyGeminiAccountAsync(page, _account.Email, cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
			worker.MarkAccountVerified(page.Url);
			await WriteRealEvidenceAsync(worker, page.Url, "ready", captureScreenshot: true).ConfigureAwait(continueOnCapturedContext: false);
		}
	}

	private async Task WriteRealEvidenceAsync(BrowserWorker worker, string verifiedUrl, string status, bool captureScreenshot)
	{
		if (_settings.RealEvidenceDirectory != null)
		{
			Directory.CreateDirectory(_settings.RealEvidenceDirectory);
			string screenshotPath = Path.Combine(_settings.RealEvidenceDirectory, "gemini-ready.jpg");
			if (captureScreenshot)
			{
				await (worker.Page ?? throw new InvalidOperationException("Browser page is unavailable for evidence capture.")).ScreenshotAsync(new PageScreenshotOptions
				{
					Path = screenshotPath,
					Type = ScreenshotType.Jpeg,
					Quality = 90,
					Animations = ScreenshotAnimations.Disabled
				}).ConfigureAwait(continueOnCapturedContext: false);
			}
			string? screenshotSha = null;
			if (File.Exists(screenshotPath))
			{
				screenshotSha = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(screenshotPath).ConfigureAwait(continueOnCapturedContext: false))).ToLowerInvariant();
			}
			string contents = JsonSerializer.Serialize(new
			{
				schemaVersion = 1,
				capturedAt = DateTimeOffset.UtcNow,
				status = status,
				verifiedUrl = verifiedUrl,
				expectedAccount = _account.Email,
				accountVerified = worker.AccountVerified,
				screenshot = (File.Exists(screenshotPath) ? Path.GetFileName(screenshotPath) : null),
				screenshotSha256 = screenshotSha,
				visibleProcessId = worker.VisibleProcessId
			}, EvidenceJsonOptions);
			await File.WriteAllTextAsync(Path.Combine(_settings.RealEvidenceDirectory, "gemini-evidence.json"), contents).ConfigureAwait(continueOnCapturedContext: false);
		}
	}

	private static async Task VerifyGeminiAccountAsync(IPage page, string expectedEmail, CancellationToken cancellationToken)
	{
		DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(20.0);
		bool accountMenuOpened = false;
		while (DateTimeOffset.UtcNow < deadline)
		{
			cancellationToken.ThrowIfCancellationRequested();
			if (await PageContainsExpectedAccountAsync(page, expectedEmail).ConfigureAwait(continueOnCapturedContext: false))
			{
				if (accountMenuOpened)
				{
					await page.Keyboard.PressAsync("Escape").ConfigureAwait(continueOnCapturedContext: false);
				}
				return;
			}
			if (!accountMenuOpened)
			{
				string[] array = new string[4] { "button[aria-label*='Google Account' i]", "a[aria-label*='Google Account' i]", "button[aria-label*='บ\u0e31ญช\u0e35 Google' i]", "a[aria-label*='บ\u0e31ญช\u0e35 Google' i]" };
				foreach (string selector in array)
				{
					ILocator candidate = page.Locator(selector).First;
					if (await candidate.IsVisibleAsync().ConfigureAwait(continueOnCapturedContext: false))
					{
						await candidate.ClickAsync().ConfigureAwait(continueOnCapturedContext: false);
						accountMenuOpened = true;
						break;
					}
				}
			}
			await Task.Delay(250, cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
		}
		if (accountMenuOpened)
		{
			await page.Keyboard.PressAsync("Escape").ConfigureAwait(continueOnCapturedContext: false);
		}
		throw new InvalidOperationException("The Gemini signed-in account could not be verified as " + expectedEmail + ".");
	}

	private static async Task<bool> PageContainsExpectedAccountAsync(IPage page, string expectedEmail)
	{
		try
		{
			if ((await page.Locator("[aria-label], [title], [data-email]").EvaluateAllAsync<string[]>("elements => elements.flatMap(element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-email')].filter(Boolean))").ConfigureAwait(continueOnCapturedContext: false)).Any((string value) => value.Contains(expectedEmail, StringComparison.OrdinalIgnoreCase)))
			{
				return true;
			}
			return (await page.EvaluateAsync<string>("() => document.body?.innerText ?? ''").ConfigureAwait(continueOnCapturedContext: false)).Contains(expectedEmail, StringComparison.OrdinalIgnoreCase);
		}
		catch (PlaywrightException)
		{
			return false;
		}
	}

	private async Task IdleCleanupAsync(BrowserWorker worker)
	{
		CancellationToken cancellationToken = worker.IdleCancellation.Token;
		try
		{
			while (!cancellationToken.IsCancellationRequested && _workers.ContainsKey(worker.User))
			{
				TimeSpan timeSpan = _settings.IdleTimeout - (DateTimeOffset.UtcNow - worker.LastActivityAt);
				if (timeSpan <= TimeSpan.Zero)
				{
					await EndAsync(worker.User).ConfigureAwait(continueOnCapturedContext: false);
					break;
				}
				await Task.Delay((timeSpan < TimeSpan.FromMinutes(1L)) ? timeSpan : TimeSpan.FromMinutes(1L), cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
			}
		}
		catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
		{
		}
	}

	private Task<IPlaywright> GetPlaywrightAsync()
	{
		lock (_gate)
		{
			if (_playwrightTask == null)
			{
				_playwrightTask = Playwright.CreateAsync();
			}
			return _playwrightTask;
		}
	}

	private static async Task<string?> WaitForEitherAsync(IPage page, IReadOnlyList<string> selectors, TimeSpan timeout, CancellationToken cancellationToken)
	{
		DateTimeOffset deadline = DateTimeOffset.UtcNow + timeout;
		while (DateTimeOffset.UtcNow < deadline)
		{
			foreach (string selector in selectors)
			{
				try
				{
					if (await page.Locator(selector).First.IsVisibleAsync().ConfigureAwait(continueOnCapturedContext: false))
					{
						return selector;
					}
				}
				catch (PlaywrightException)
				{
				}
			}
			await Task.Delay(250, cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
		}
		return null;
	}

	private static async Task WaitForGeminiAsync(IPage page, TimeSpan timeout, CancellationToken cancellationToken)
	{
		await page.WaitForURLAsync(new Regex("^https://gemini\\.google\\.com(?:/|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), new PageWaitForURLOptions
		{
			Timeout = (float)timeout.TotalMilliseconds,
			WaitUntil = WaitUntilState.DOMContentLoaded
		}).WaitAsync(cancellationToken).ConfigureAwait(continueOnCapturedContext: false);
	}

	private static bool IsGeminiUrl(string value)
	{
		if (Uri.TryCreate(value, UriKind.Absolute, out Uri? result))
		{
			return string.Equals(result.Host, "gemini.google.com", StringComparison.OrdinalIgnoreCase);
		}
		return false;
	}

	private static string PublicLaunchError(Exception exception)
	{
		if (exception.Message.Contains("timeout", StringComparison.OrdinalIgnoreCase) || exception.Message.Contains("verification", StringComparison.OrdinalIgnoreCase) || exception.Message.Contains("could not be verified", StringComparison.OrdinalIgnoreCase) || exception.Message.Contains("challenge", StringComparison.OrdinalIgnoreCase) || exception.Message.Contains("supported password step", StringComparison.OrdinalIgnoreCase))
		{
			return "Google ต\u0e49องการข\u0e31\u0e49นตอนย\u0e37นย\u0e31นเพ\u0e34\u0e48มเต\u0e34ม กร\u0e38ณาให\u0e49ผ\u0e39\u0e49ด\u0e39แลตรวจ account ก\u0e48อน";
		}
		return "ไม\u0e48สามารถเป\u0e34ด Secure Browser ได\u0e49";
	}

	private static float Clamp(double? value, double minimum, double maximum)
	{
		return (float)Math.Clamp(value.GetValueOrDefault(), minimum, maximum);
	}
}

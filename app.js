(() => {
  const cfg = window.POLICE_RP_CONFIG || {};
  const configured = cfg.supabaseUrl && !cfg.supabaseUrl.includes("VOTRE-PROJET")
    && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.includes("VOTRE_CLE");
  const $ = (id) => document.getElementById(id);
  let supabaseClient = null;
  let currentAttempt = null;
  let questions = [];
  let answers = {};
  let currentIndex = 0;
  let deadline = null;
  let timerInterval = null;
  let hiddenSinceLastVisible = false;
  let visibilityEventPending = false;
  let localExitCount = 0;
  let eventQueue = [];

  function message(id, text, isError = true) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "var(--red)" : "#18794e";
  }

  function setAuthenticated(user) {
    $("auth-panel").classList.toggle("hidden", !!user);
    $("candidate-panel").classList.toggle("hidden", !user);
    if (user) { $("candidate-heading").textContent = "Votre espace de sélection"; loadMyResults(); }
  }

  const networkError = () => Object.assign(new Error("Le serveur ne répond pas (connexion trop lente ou coupée)."), { network: true });
  async function callFunction(name, payload, timeoutMs = 20000) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) throw new Error("Votre session a expiré. Reconnectez-vous.");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${cfg.functionsBaseUrl}/${name}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": cfg.supabaseAnonKey
        },
        body: JSON.stringify(payload || {})
      });
      const data = await response.json().catch(() => ({}));
      if (controller.signal.aborted) throw networkError();
      if (!response.ok) throw new Error(data.error || "La requête n'a pas abouti.");
      return data;
    } catch (error) {
      if (error.network) throw error;
      if (error.name === "AbortError" || error instanceof TypeError) throw networkError();
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!configured || !supabaseClient) {
      message("auth-message", "Le site n'est pas encore configuré. Renseignez les paramètres Supabase dans config.js.");
      return;
    }
    message("auth-message", "Connexion en cours…", false);
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value
    });
    if (error) return message("auth-message", "Connexion impossible. Vérifiez vos identifiants.");
    message("auth-message", "", false);
  });

  $("logout-button").addEventListener("click", async () => {
    if (currentAttempt) {
      message("exam-message", "Terminez l'examen avant de vous déconnecter.");
      return;
    }
    await supabaseClient.auth.signOut();
  });

  $("start-button").addEventListener("click", async () => {
    const code = $("exam-code").value.trim();
    if (!code) return message("start-message", "Saisissez le code communiqué par le recruteur.");
    $("start-button").disabled = true;
    try {
      const result = await callFunction("quick-action", { examCode: code });
      currentAttempt = result.attempt;
      questions = result.questions;
      answers = {};
      currentIndex = 0;
      localExitCount = 0;
      eventQueue = [];
      deadline = new Date(result.attempt.deadline_at).getTime();
      $("candidate-home").classList.add("hidden");
      $("exam-view").classList.remove("hidden");
      renderQuestion();
      startTimer();
      message("exam-message", result.resumed ? "Tentative reprise : vos réponses précédentes n'ont pas été conservées, le chronomètre n'a pas été interrompu." : "Examen démarré. Le chronomètre continue si vous quittez la page.", false);
    } catch (error) {
      message("start-message", error.message || "Impossible de démarrer l'examen.");
    } finally {
      $("start-button").disabled = false;
    }
  });

  function renderQuestion() {
    const q = questions[currentIndex];
    if (!q) return;
    $("progress").textContent = `${currentIndex + 1} / ${questions.length}`;
    $("progress-bar").style.width = `${((currentIndex + 1) / questions.length) * 100}%`;
    const container = $("question-container");
    container.replaceChildren();
    const kicker = document.createElement("p");
    kicker.className = "question-kicker";
    kicker.textContent = `QUESTION ${String(currentIndex + 1).padStart(2, "0")}`;
    const title = document.createElement("h3");
    title.className = "question-title";
    title.textContent = q.prompt;
    container.append(kicker, title);
    q.options.forEach((option) => {
      const label = document.createElement("label");
      label.className = "option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "answer";
      radio.value = option.id;
      radio.checked = answers[q.id] === option.id;
      radio.addEventListener("change", () => { answers[q.id] = option.id; });
      const text = document.createElement("span");
      text.textContent = option.text;
      label.append(radio, text);
      container.append(label);
    });
    $("previous-button").disabled = currentIndex === 0;
    $("next-button").textContent = currentIndex === questions.length - 1 ? "Terminer l'examen" : "Suivante";
  }

  $("previous-button").addEventListener("click", () => {
    if (currentIndex > 0) { currentIndex--; renderQuestion(); }
  });

  let submitting = false;
  async function submitAnswers() {
    let sawNetworkError = false, lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callFunction("super-service", {
          attemptId: currentAttempt.id,
          answers: Object.entries(answers).map(([questionId, optionId]) => ({ questionId, optionId })),
          events: eventQueue
        });
      } catch (error) {
        lastError = error;
        if (sawNetworkError && /déjà terminée/.test(error.message || "")) {
          return { answeredCount: Object.keys(answers).length }; // le premier envoi était bien arrivé
        }
        if (!error.network) break;
        sawNetworkError = true;
        message("exam-message", `Connexion lente, nouvel essai d'envoi (${attempt + 2}/3)…`, false);
      }
    }
    throw lastError;
  }

  $("next-button").addEventListener("click", async () => {
    if (submitting) return;
    const timeUp = Date.now() >= deadline;
    if (currentIndex < questions.length - 1 && !timeUp) {
      currentIndex++;
      renderQuestion();
      return;
    }
    const unanswered = questions.filter(q => !answers[q.id]).length;
    if (!timeUp && unanswered > 0 && !window.confirm(`Il reste ${unanswered} question(s) sans réponse. Transmettre quand même ?`)) return;
    submitting = true;
    $("next-button").disabled = true;
    $("previous-button").disabled = true;
    $("next-button").textContent = "Envoi en cours…";
    message("exam-message", "Transmission de vos réponses en cours, ne fermez pas la page…", false);
    try {
      try { await flushChain; } catch (_) { /* un envoi d'événements en cours : on continue */ }
      const result = await submitAnswers();
      stopTimer();
      const finishedId = currentAttempt.id;
      currentAttempt = null;
      $("exam-view").classList.add("hidden");
      $("exam-finished").classList.remove("hidden");
      showFinishWarning(finishedId, localExitCount);
      $("finish-summary").textContent = `Examen transmis · Réponses traitées : ${result.answeredCount}/${questions.length}.`;
      message("exam-message", "", false);
    } catch (error) {
      $("next-button").textContent = "Réessayer l'envoi";
      message("exam-message", `${error.message || "La transmission a échoué."} Vos réponses sont conservées : cliquez sur « Réessayer l'envoi ».`);
    } finally {
      submitting = false;
      $("next-button").disabled = false;
      $("previous-button").disabled = currentIndex === 0;
    }
  });

  function startTimer() {
    stopTimer();
    updateTimer();
    timerInterval = window.setInterval(updateTimer, 1000);
  }
  function stopTimer() {
    if (timerInterval) window.clearInterval(timerInterval);
    timerInterval = null;
  }
  function updateTimer() {
    const seconds = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    $("timer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    if (seconds <= 0) {
      stopTimer();
      message("exam-message", "Temps écoulé. Transmettez vos réponses immédiatement.");
      $("next-button").textContent = "Transmettre les réponses";
    }
  }

  let flushChain = Promise.resolve();
  function flushEvents() {
    // Un seul envoi à la fois : évite que les mêmes sorties soient comptées deux fois par le serveur.
    flushChain = flushChain.then(doFlush, doFlush);
    return flushChain;
  }
  async function doFlush() {
    if (!currentAttempt || !eventQueue.length) return;
    const batch = eventQueue.slice();
    await callFunction("super-service", { attemptId: currentAttempt.id, events: batch, eventsOnly: true });
    eventQueue = eventQueue.slice(batch.length);
  }

  document.addEventListener("visibilitychange", () => {
    if (!currentAttempt) return;
    if (document.visibilityState === "hidden") {
      if (!hiddenSinceLastVisible) {
        hiddenSinceLastVisible = true;
        localExitCount++;
        eventQueue.push({ type: "page_hidden", occurredAt: new Date().toISOString(), sequence: localExitCount });
        message("exam-message", `Attention : sortie de page détectée (${localExitCount}). À partir de 3 sorties, votre session sera signalée.`);
      }
    } else if (hiddenSinceLastVisible) {
      hiddenSinceLastVisible = false;
      eventQueue.push({ type: "page_visible", occurredAt: new Date().toISOString(), sequence: localExitCount });
      if (localExitCount >= 3) message("exam-message", "Votre session sera signalée au recruteur pour vérification.");
      // Best effort only: a network interruption may prevent immediate event delivery.
      flushEvents().catch(() => {});
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (currentAttempt) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  function statusOf(r) {
    if (r.status === "in_progress") return { text: "En cours", cls: "" };
    if (r.unlocked) return { text: "Nouvelle tentative autorisée", cls: "" };
    if (r.review_status === "pending") return { text: "En attente de vérification par un recruteur", cls: "warn" };
    if (r.review_status === "refused") return { text: "Refusé — nouvelle tentative uniquement sur autorisation d'un recruteur", cls: "bad" };
    return r.passed ? { text: "Réussi", cls: "ok" }
      : { text: "Échoué — nouvelle tentative uniquement sur autorisation d'un recruteur", cls: "bad" };
  }
  async function loadMyResults() {
    const box = $("my-results");
    if (!box || !supabaseClient) return;
    const { data, error } = await supabaseClient.rpc("my_results");
    if (error) { box.textContent = ""; return; }
    const latest = new Map();
    (data || []).forEach((r) => { if (!latest.has(r.exam_id)) latest.set(r.exam_id, r); });
    box.replaceChildren();
    if (!latest.size) { box.textContent = "Aucun examen passé pour le moment."; return; }
    latest.forEach((r) => {
      const row = document.createElement("div");
      row.className = "result-row";
      const name = document.createElement("strong");
      name.textContent = r.exam_title;
      const s = statusOf(r);
      const tag = document.createElement("span");
      tag.className = `tag ${s.cls}`;
      tag.textContent = s.text;
      row.append(name, tag);
      box.append(row);
    });
  }
  $("back-home").addEventListener("click", () => {
    $("exam-finished").classList.add("hidden");
    $("candidate-home").classList.remove("hidden");
    $("exam-code").value = "";
    message("start-message", "", false);
    loadMyResults();
  });

  $("pw-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = $("pw-current").value, next = $("pw-new").value, again = $("pw-confirm").value;
    if (next.length < 8) return message("pw-message", "Le nouveau mot de passe doit contenir au moins 8 caractères.");
    if (next !== again) return message("pw-message", "Les deux mots de passe ne correspondent pas.");
    if (next === current) return message("pw-message", "Le nouveau mot de passe doit être différent de l'ancien.");
    message("pw-message", "Modification en cours…", false);
    const { data: { session } } = await supabaseClient.auth.getSession();
    const email = session && session.user && session.user.email;
    if (!email) return message("pw-message", "Votre session a expiré. Reconnectez-vous.");
    const check = await supabaseClient.auth.signInWithPassword({ email, password: current });
    if (check.error) return message("pw-message", "Mot de passe actuel incorrect.");
    const { error } = await supabaseClient.auth.updateUser({ password: next });
    if (error) return message("pw-message", "Modification impossible : " + error.message);
    $("pw-form").reset();
    message("pw-message", "Mot de passe modifié.", false);
  });

  async function showFinishWarning(attemptId, localCount) {
    const warn = $("finish-warning");
    const text = (n) => `⚠ ATTENTION : une suspicion de triche a été détectée pendant votre examen (${n} sorties de la page). Une vérification par un recruteur est nécessaire.`;
    warn.textContent = localCount >= 3 ? text(localCount) : "";
    try {
      const { data } = await supabaseClient.rpc("my_results");
      const r = (data || []).find((x) => x.attempt_id === attemptId);
      if (r && (r.flagged_for_review || r.review_status === "pending")) warn.textContent = text(r.suspicious_exit_count || localCount);
    } catch (_) { /* l'alerte locale reste affichée */ }
  }

  async function init() {
    if (!configured || !window.supabase) {
      $("auth-message").textContent = "Configuration requise : renseignez config.js puis déployez les fonctions Supabase.";
      return;
    }
    supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data: { session } } = await supabaseClient.auth.getSession();
    setAuthenticated(session?.user || null);
    supabaseClient.auth.onAuthStateChange((_event, nextSession) => setAuthenticated(nextSession?.user || null));
  }
  init();
})();
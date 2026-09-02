(function () {
  "use strict";

  var APP_NAME = "new-rogovin";
  var HOST_ORIGINS = ["https://mnt.ylm.co.il", "https://simplylog.ylm.co.il"];
  var RTL_LANGS = ["he", "ar", "fa", "ur"];
  var acceptedHostOrigin = "";
  var hostContextPromise = listenForHostContext();

  if (!window.XState) {
    document.getElementById("app").innerHTML = '<section class="status-card"><h1>לא ניתן לפתוח את הטופס</h1><p>יש לבדוק את החיבור לרשת ולנסות שוב.</p></section>';
    return;
  }

  function isAllowedOrigin(origin) {
    return HOST_ORIGINS.indexOf(origin) !== -1;
  }

  function listenForHostContext() {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () {
        if (!settled) reject(new Error("HOST_TIMEOUT"));
      }, 7000);

      window.addEventListener("message", function (event) {
        if (settled || !isAllowedOrigin(event.origin)) return;
        try {
          var payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
          if (!payload || typeof payload !== "object") throw new Error("INVALID_CONTEXT");
          settled = true;
          acceptedHostOrigin = event.origin;
          window.clearTimeout(timer);
          resolve(payload);
        } catch (error) {
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  function resolveLocale(runtime) {
    var raw = String(runtime.CultureInfo || runtime.LanguageCode || "he").toLowerCase();
    var language = raw.split(/[-_]/)[0] || "he";
    var configured = String(runtime.LanguageDirection || "").toLowerCase();
    var direction = configured === "rtl" || configured === "ltr" ? configured : (RTL_LANGS.indexOf(language) >= 0 ? "rtl" : "ltr");
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
    return { language: language, direction: direction };
  }

  function parseAppConnections(configuration) {
    return (Array.isArray(configuration) ? configuration : []).reduce(function (result, item) {
      if (!item || item.Group !== "Connections" || typeof item.Name !== "string" || item.Name.indexOf(APP_NAME) !== 0) return result;
      var key = item.Name.slice(APP_NAME.length).replace(/^[._:-]+/, "") || item.Name;
      var value = item.Value;
      if (typeof value === "string") { try { value = JSON.parse(value); } catch (_) {} }
      result[key] = value;
      return result;
    }, {});
  }

  function createApiClient(runtime) {
    var baseUrl = String(runtime.ApiAddress || "").replace(/\/+$/, "");
    var token = runtime.Token || {};
    if (!baseUrl || !token.access_token) throw new Error("MISSING_SESSION");
    return {
      request: async function (path, options) {
        options = options || {};
        var headers = Object.assign({}, options.headers || {}, { Authorization: String(token.token_type || "bearer") + " " + token.access_token });
        var body = options.body;
        if (body && typeof body === "object" && !(body instanceof FormData)) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(body);
        }
        var response = await fetch(baseUrl + path, { method: options.method || "GET", headers: headers, body: body });
        var contentType = response.headers.get("content-type") || "";
        var data = contentType.indexOf("json") >= 0 ? await response.json().catch(function () { return {}; }) : await response.text();
        if (!response.ok) {
          var error = new Error(response.status === 401 ? "SESSION_EXPIRED" : response.status === 403 ? "FORBIDDEN" : "REQUEST_FAILED");
          error.status = response.status;
          error.details = data;
          throw error;
        }
        return data;
      }
    };
  }

  function connectionSettings(connections) {
    var configured = connections.api || connections.settings || connections.default || {};
    return typeof configured === "object" && configured ? configured : {};
  }

  function listFrom(data) {
    if (Array.isArray(data)) return data;
    return data && (data.Items || data.items || data.value || data.Results || data.results) || [];
  }

  function normalizeLocation(item) {
    return { id: item.Id ?? item.id ?? item.EntityId ?? item.entityId, name: item.FullName || item.fullName || item.Name || item.name || item.LocationFullName };
  }

  function normalizeCategory(item) {
    return { id: item.Id ?? item.id ?? item.CategoryId ?? item.categoryId, name: item.Name || item.name || item.FullName || item.fullName, icon: item.Icon || item.icon };
  }

  function iconDisplay(icon) {
    var value = String(icon || "").trim();
    if (!value) return "";
    if (/^[\p{Extended_Pictographic}\u2600-\u27BF]/u.test(value)) return value;
    var known = { plumbing: "🚰", electricity: "💡", cleaning: "🧹", elevator: "🛗", security: "🔒", parking: "🚗", maintenance: "🛠️" };
    return known[value.toLowerCase()] || "🛠️";
  }

  async function loadFormData(ctx) {
    var settings = ctx.settings;
    var locationPath = settings.locationsEndpoint || "/api/Locations/My";
    var categoryPath = settings.categoriesEndpoint || "/api/EventCategories";
    var responses = await Promise.all([ctx.api.request(locationPath), ctx.api.request(categoryPath)]);
    var locations = listFrom(responses[0]).map(normalizeLocation).filter(function (x) { return x.id != null && x.name; });
    var categories = listFrom(responses[1]).map(normalizeCategory).filter(function (x) { return x.id != null && x.name && x.icon; });
    if (!locations.length && ctx.runtime.LocationEntityId) locations.push({ id: ctx.runtime.LocationEntityId, name: ctx.runtime.LocationFullName || "המיקום שלי" });
    return { locations: locations, categories: categories };
  }

  async function uploadAttachment(ctx, eventId, file) {
    if (!file) return;
    var form = new FormData();
    form.append("file", file, file.name);
    form.append("EventId", String(eventId));
    await ctx.api.request(ctx.settings.attachmentEndpoint || ("/api/Attachments/Event/" + encodeURIComponent(eventId)), { method: "POST", body: form });
  }

  async function submitReport(ctx, form) {
    var body = {
      LocationEntityId: Number(form.locationId),
      CategoryId: Number(form.categoryId),
      Description: form.description.trim()
    };
    var result = await ctx.api.request(ctx.settings.createEventEndpoint || "/api/Events/Create", { method: "POST", body: body });
    var eventId = result.Id || result.id || result.EventId || result.eventId;
    if (!eventId) throw new Error("INVALID_CREATE_RESPONSE");
    await uploadAttachment(ctx, eventId, form.file);
    return { eventId: eventId };
  }

  var machine = XState.createMachine({
    id: "newReport",
    initial: "bootstrapping",
    context: { runtime: null, api: null, settings: {}, locations: [], categories: [], form: { locationId: "", categoryId: "", description: "", file: null }, result: null, error: "" },
    states: {
      bootstrapping: { invoke: { src: "bootstrap", onDone: { target: "loading", actions: XState.assign(function (_, e) { return e.data; }) }, onError: { target: "landing", actions: XState.assign({ error: function (_, e) { return messageOf(e.data); } }) } } },
      loading: { invoke: { src: "load", onDone: { target: "ready", actions: XState.assign({ locations: function (_, e) { return e.data.locations; }, categories: function (_, e) { return e.data.categories; }, form: function (ctx, e) { return Object.assign({}, ctx.form, { locationId: e.data.locations[0] ? String(e.data.locations[0].id) : "" }); } }) }, onError: { target: "error", actions: "setError" } } },
      ready: { on: { UPDATE: { actions: "updateForm" }, SUBMIT: "saving", REFRESH: "loading" } },
      saving: { invoke: { src: "save", onDone: { target: "success", actions: XState.assign({ result: function (_, e) { return e.data; } }) }, onError: { target: "ready", actions: "setError" } } },
      success: { on: { NEW_REPORT: { target: "ready", actions: "resetForm" }, OPEN_EVENT: { actions: "openEvent" } } },
      error: { on: { RETRY: "loading" } },
      landing: { type: "final" }
    }
  }, {
    actions: {
      updateForm: XState.assign({ form: function (ctx, e) { return Object.assign({}, ctx.form, e.value); }, error: function () { return ""; } }),
      setError: XState.assign({ error: function (_, e) { return messageOf(e.data); } }),
      resetForm: XState.assign({ form: function (ctx) { return { locationId: ctx.locations[0] ? String(ctx.locations[0].id) : "", categoryId: "", description: "", file: null }; }, error: function () { return ""; } }),
      openEvent: function (ctx) {
        if (acceptedHostOrigin) window.parent.postMessage({ type: "SIMPLYLOG_NAVIGATE", appName: APP_NAME, target: "event", eventId: ctx.result.eventId }, acceptedHostOrigin);
      }
    },
    services: {
      bootstrap: async function () {
        var runtime = await hostContextPromise;
        var locale = resolveLocale(runtime);
        var connections = parseAppConnections(runtime.Configuration);
        return { runtime: Object.assign({}, runtime, { connections: connections, locale: locale }), api: createApiClient(runtime), settings: connectionSettings(connections) };
      },
      load: loadFormData,
      save: function (ctx) { return submitReport(ctx, ctx.form); }
    }
  });

  function messageOf(error) {
    var code = String(error && (error.message || error) || "");
    if (code.indexOf("SESSION_EXPIRED") >= 0 || code.indexOf("MISSING_SESSION") >= 0) return "החיבור למערכת פג. יש לרענן את SimplyLog ולהיכנס שוב.";
    if (code.indexOf("FORBIDDEN") >= 0) return "אין הרשאה לביצוע הפעולה. אפשר לפנות למנהל המערכת.";
    return "לא הצלחנו להשלים את הפעולה. כדאי לנסות שוב בעוד רגע.";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, function (char) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[char]; });
  }

  var app = document.getElementById("app");
  var service = XState.interpret(machine).onTransition(function (state) {
    if (state.event && state.event.type === "UPDATE" && Object.prototype.hasOwnProperty.call(state.event.value || {}, "description")) {
      var counter = app.querySelector(".counter");
      if (counter) counter.textContent = state.context.form.description.length + "/2000";
      return;
    }
    render(state);
  });

  function render(state) {
    var ctx = state.context;
    if (state.matches("bootstrapping")) return;
    if (state.matches("landing")) {
      app.innerHTML = '<section class="status-card"><h1>דיווח תקלות ובקשות</h1><p>הטופס זמין מתוך אפליקציית SimplyLog. יש לפתוח אותו מהתפריט במערכת.</p></section>';
      return;
    }
    if (state.matches("loading")) {
      app.innerHTML = '<section class="status-card"><span class="spinner" aria-hidden="true"></span><h1>מכינים את הטופס…</h1><p>טוענים מיקומים וקטגוריות.</p></section>';
      return;
    }
    if (state.matches("error")) {
      app.innerHTML = '<section class="status-card"><h1>לא הצלחנו לטעון את הטופס</h1><p>' + escapeHtml(ctx.error) + '</p><button class="primary" data-action="retry">ניסיון נוסף</button></section>';
      return;
    }
    if (state.matches("success")) {
      app.innerHTML = '<section class="status-card"><div class="success-mark">✓</div><h1>הדיווח התקבל</h1><p>מספר הדיווח: ' + escapeHtml(ctx.result.eventId) + '</p><div class="actions"><button class="primary" data-action="open">לפרטי הדיווח</button><button class="secondary" data-action="new">דיווח נוסף</button></div></section>';
      return;
    }
    var saving = state.matches("saving");
    var categories = ctx.categories.length ? ctx.categories.map(function (item) {
      var selected = String(item.id) === String(ctx.form.categoryId);
      return '<button type="button" class="category' + (selected ? ' selected' : '') + '" data-category="' + escapeHtml(item.id) + '" aria-pressed="' + selected + '"><span class="category-icon" aria-hidden="true">' + escapeHtml(iconDisplay(item.icon)) + '</span><span class="category-name">' + escapeHtml(item.name) + '</span></button>';
    }).join("") : '<p class="empty">אין כרגע קטגוריות זמינות לדיווח.</p>';
    var locations = ctx.locations.map(function (item) { return '<option value="' + escapeHtml(item.id) + '"' + (String(item.id) === String(ctx.form.locationId) ? ' selected' : '') + '>' + escapeHtml(item.name) + '</option>'; }).join("");
    var valid = ctx.form.locationId && ctx.form.categoryId && ctx.form.description.trim();
    app.innerHTML = '<header class="hero"><p class="eyebrow">שירות לדיירים</p><h1>במה נוכל לעזור?</h1><p class="subtitle">מדווחים בכמה צעדים קצרים, ואנחנו נדאג להעביר את הפנייה למקום הנכון.</p></header><form class="card" id="report-form">' +
      (ctx.error ? '<p class="error-box" role="alert">' + escapeHtml(ctx.error) + '</p>' : '') +
      '<div class="field"><label for="location">איפה זה קרה?</label><select id="location" name="location" required' + (ctx.locations.length < 2 ? ' disabled' : '') + '>' + locations + '</select>' + (ctx.locations.length < 2 ? '<p class="hint">זה המיקום שמשויך לחשבון שלך.</p>' : '<p class="hint">אפשר לבחור אחד מהמיקומים שמשויכים אליך.</p>') + '</div>' +
      '<fieldset class="field" style="border:0;padding:0"><legend class="field-label">מה סוג הפנייה?</legend><p class="hint">בחרו את הקטגוריה המתאימה ביותר.</p><div class="category-grid">' + categories + '</div></fieldset>' +
      '<div class="field"><label for="description">מה תרצו לספר לנו?</label><textarea id="description" maxlength="2000" required placeholder="תיאור קצר וברור יעזור לנו לטפל בפנייה מהר יותר">' + escapeHtml(ctx.form.description) + '</textarea><span class="counter">' + ctx.form.description.length + '/2000</span></div>' +
      '<div class="field"><label class="upload" for="attachment"><strong>צרפו תמונה או קובץ (לא חובה)</strong><span class="hint">עד 10MB</span><input id="attachment" type="file" accept="image/*,.pdf,.doc,.docx">' + (ctx.form.file ? '<span class="file-name">' + escapeHtml(ctx.form.file.name) + '</span>' : '') + '</label></div>' +
      '<div class="actions"><button class="primary" type="submit"' + (!valid || saving ? ' disabled' : '') + '>' + (saving ? 'שולחים את הדיווח…' : 'שליחת הדיווח') + '</button></div></form>';
  }

  app.addEventListener("click", function (event) {
    var category = event.target.closest("[data-category]");
    if (category) service.send({ type: "UPDATE", value: { categoryId: category.dataset.category } });
    var action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "retry") service.send("RETRY");
    if (action.dataset.action === "new") service.send("NEW_REPORT");
    if (action.dataset.action === "open") service.send("OPEN_EVENT");
  });
  app.addEventListener("input", function (event) {
    if (event.target.id === "description") service.send({ type: "UPDATE", value: { description: event.target.value } });
  });
  app.addEventListener("change", function (event) {
    if (event.target.id === "location") service.send({ type: "UPDATE", value: { locationId: event.target.value } });
    if (event.target.id === "attachment") {
      var file = event.target.files[0] || null;
      if (file && file.size > 10 * 1024 * 1024) { event.target.value = ""; alert("הקובץ גדול מ־10MB. יש לבחור קובץ קטן יותר."); return; }
      service.send({ type: "UPDATE", value: { file: file } });
    }
  });
  app.addEventListener("submit", function (event) { event.preventDefault(); service.send("SUBMIT"); });

  service.start();
})();

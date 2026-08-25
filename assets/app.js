/* Lab Explorer — client-side filtering over ./data/labs.json.
   No framework, no build step, no dependencies. */

(function () {
  "use strict";

  var DATA_URL = "./data/labs.json";

  var state = {
    q: "",
    repo: [],
    level: [],
    duration: "",
    status: [],
    topic: [],
  };

  var labs = [];
  var meta = null;

  var el = {
    form: document.getElementById("filters"),
    q: document.getElementById("q"),
    repo: document.getElementById("repo"),
    level: document.getElementById("level"),
    duration: document.getElementById("duration"),
    status: document.getElementById("status"),
    topic: document.getElementById("topic"),
    topicSearch: document.getElementById("topic-search"),
    clear: document.getElementById("clear"),
    cards: document.getElementById("cards"),
    count: document.getElementById("count"),
    activeFilters: document.getElementById("active-filters"),
    empty: document.getElementById("empty"),
    error: document.getElementById("error"),
    errorDetail: document.getElementById("error-detail"),
    freshness: document.getElementById("freshness"),
  };

  var MULTI = ["repo", "level", "status", "topic"];
  var UNSET_STATUS = "(unspecified)";

  /* ---------------- helpers ---------------- */

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(null, args);
      }, ms);
    };
  }

  function searchText(lab) {
    if (lab._search === undefined) {
      lab._search = [lab.title, lab.description, lab.repoTitle, (lab.topics || []).join(" ")]
        .join(" ")
        .toLowerCase();
    }
    return lab._search;
  }

  function statusOf(lab) {
    return lab.status || UNSET_STATUS;
  }

  function durationBucket(lab) {
    if (typeof lab.duration !== "number") return null;
    if (lab.duration <= 30) return "30";
    if (lab.duration <= 45) return "45";
    if (lab.duration <= 60) return "60";
    return "60+";
  }

  /** Duration is a nested bucket: "<=45" also includes everything "<=30". */
  function matchesDuration(lab, value) {
    if (!value) return true;
    if (typeof lab.duration !== "number") return false;
    if (value === "60+") return lab.duration > 60;
    return lab.duration <= Number(value);
  }

  function formatMinutes(total) {
    if (!total) return "0 min";
    var h = Math.floor(total / 60);
    var m = total % 60;
    if (h && m) return h + " hr " + m + " min";
    if (h) return h + " hr";
    return m + " min";
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  /* ---------------- predicates ---------------- */

  /** Builds the set of predicates, optionally omitting one facet (for counts). */
  function predicates(skip) {
    var tests = [];
    var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);

    if (skip !== "q" && terms.length) {
      tests.push(function (lab) {
        var hay = searchText(lab);
        return terms.every(function (t) {
          return hay.indexOf(t) !== -1;
        });
      });
    }
    if (skip !== "repo" && state.repo.length) {
      tests.push(function (lab) {
        return state.repo.indexOf(lab.repo) !== -1;
      });
    }
    if (skip !== "level" && state.level.length) {
      tests.push(function (lab) {
        return state.level.indexOf(String(lab.level)) !== -1;
      });
    }
    if (skip !== "duration" && state.duration) {
      tests.push(function (lab) {
        return matchesDuration(lab, state.duration);
      });
    }
    if (skip !== "status" && state.status.length) {
      tests.push(function (lab) {
        return state.status.indexOf(statusOf(lab)) !== -1;
      });
    }
    if (skip !== "topic" && state.topic.length) {
      tests.push(function (lab) {
        return (lab.topics || []).some(function (t) {
          return state.topic.indexOf(t) !== -1;
        });
      });
    }
    return tests;
  }

  function filterLabs(skip) {
    var tests = predicates(skip);
    if (!tests.length) return labs.slice();
    return labs.filter(function (lab) {
      return tests.every(function (t) {
        return t(lab);
      });
    });
  }

  /* ---------------- URL state ---------------- */

  function readUrl() {
    var p = new URLSearchParams(window.location.search);
    state.q = p.get("q") || "";
    state.duration = p.get("duration") || "";
    MULTI.forEach(function (key) {
      var raw = p.getAll(key);
      var values = [];
      raw.forEach(function (v) {
        v.split("|").forEach(function (part) {
          if (part) values.push(part);
        });
      });
      state[key] = values;
    });
  }

  function writeUrl(replace) {
    var p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    MULTI.forEach(function (key) {
      if (state[key].length) p.set(key, state[key].join("|"));
    });
    if (state.duration) p.set("duration", state.duration);

    var qs = p.toString();
    var url = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }

  /* ---------------- facet rendering ---------------- */

  function optionLists() {
    return {
      repo: uniqueBy(
        labs.map(function (l) {
          return { value: l.repo, label: l.repoTitle };
        })
      ).sort(byLabel),
      level: uniqueBy(
        labs
          .filter(function (l) {
            return l.level != null;
          })
          .map(function (l) {
            return { value: String(l.level), label: "Level " + l.level };
          })
      ).sort(function (a, b) {
        return Number(a.value) - Number(b.value);
      }),
      status: uniqueBy(
        labs.map(function (l) {
          return { value: statusOf(l), label: statusOf(l) };
        })
      ).sort(byLabel),
      topic: uniqueBy(
        labs.reduce(function (acc, l) {
          (l.topics || []).forEach(function (t) {
            acc.push({ value: t, label: t });
          });
          return acc;
        }, [])
      ).sort(byLabel),
    };
  }

  function byLabel(a, b) {
    return a.label.localeCompare(b.label);
  }

  function uniqueBy(items) {
    var seen = Object.create(null);
    var out = [];
    items.forEach(function (i) {
      if (!seen[i.value]) {
        seen[i.value] = true;
        out.push(i);
      }
    });
    return out;
  }

  var OPTIONS = null;

  function countsFor(key) {
    var pool = filterLabs(key);
    var counts = Object.create(null);
    pool.forEach(function (lab) {
      var keys;
      if (key === "repo") keys = [lab.repo];
      else if (key === "level") keys = lab.level == null ? [] : [String(lab.level)];
      else if (key === "status") keys = [statusOf(lab)];
      else keys = lab.topics || [];
      keys.forEach(function (k) {
        counts[k] = (counts[k] || 0) + 1;
      });
    });
    return counts;
  }

  function renderSelect(key) {
    var select = el[key];
    var counts = countsFor(key);
    var selected = state[key];
    var needle = key === "topic" ? el.topicSearch.value.trim().toLowerCase() : "";

    var frag = document.createDocumentFragment();
    OPTIONS[key].forEach(function (opt) {
      var isSelected = selected.indexOf(opt.value) !== -1;
      var n = counts[opt.value] || 0;
      // Keep selected options visible even when they fall outside the topic search.
      if (needle && !isSelected && opt.label.toLowerCase().indexOf(needle) === -1) return;
      var o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label + " (" + n + ")";
      o.selected = isSelected;
      if (n === 0 && !isSelected) o.classList.add("is-zero");
      frag.appendChild(o);
    });

    select.textContent = "";
    select.appendChild(frag);
  }

  function renderFacets() {
    MULTI.forEach(renderSelect);
    el.duration.value = state.duration;
    if (el.q.value !== state.q) el.q.value = state.q;
  }

  /* ---------------- results ---------------- */

  function tag(text, variant) {
    var li = document.createElement("li");
    li.className = "tag" + (variant ? " tag--" + variant : "");
    li.textContent = text;
    return li;
  }

  function renderCard(lab) {
    var li = document.createElement("li");
    li.className = "card";

    var repo = document.createElement("p");
    repo.className = "repo";
    repo.textContent = lab.repoTitle;
    li.appendChild(repo);

    var h2 = document.createElement("h2");
    var a = document.createElement("a");
    a.href = lab.hostedUrl || lab.sourceUrl;
    a.textContent = lab.title;
    a.rel = "noopener";
    h2.appendChild(a);
    li.appendChild(h2);

    if (lab.description) {
      var desc = document.createElement("p");
      desc.className = "desc";
      desc.textContent = lab.description;
      li.appendChild(desc);
    }

    var tags = document.createElement("ul");
    tags.className = "tags";
    if (lab.level != null) tags.appendChild(tag("L" + lab.level, "accent"));
    if (typeof lab.duration === "number") {
      var durTag = tag(lab.duration + " min");
      durTag.dataset.duration = String(lab.duration);
      tags.appendChild(durTag);
    }
    if (lab.status && lab.status !== "released") tags.appendChild(tag(lab.status, "warn"));
    (lab.topics || []).forEach(function (t) {
      tags.appendChild(tag(t));
    });
    if (lab.extra && lab.extra.type) tags.appendChild(tag(lab.extra.type));
    if (lab.extra && lab.extra.section) tags.appendChild(tag(lab.extra.section));
    if (tags.childNodes.length) li.appendChild(tags);

    var metaRow = document.createElement("p");
    metaRow.className = "meta";
    var src = document.createElement("a");
    src.href = lab.sourceUrl;
    src.rel = "noopener";
    src.textContent = "source";
    src.setAttribute("aria-label", "View source of " + lab.title + " on GitHub");
    metaRow.appendChild(src);
    var pathSpan = document.createElement("span");
    pathSpan.textContent = lab.path;
    metaRow.appendChild(pathSpan);
    li.appendChild(metaRow);

    return li;
  }

  function render() {
    var results = filterLabs(null);

    OPTIONS = OPTIONS || optionLists();
    renderFacets();

    var frag = document.createDocumentFragment();
    results.forEach(function (lab) {
      frag.appendChild(renderCard(lab));
    });
    el.cards.textContent = "";
    el.cards.appendChild(frag);

    var totalMinutes = results.reduce(function (sum, l) {
      return sum + (typeof l.duration === "number" ? l.duration : 0);
    }, 0);

    var summary = "Showing " + results.length + " of " + labs.length + " labs";
    if (totalMinutes) summary += " \u00b7 " + formatMinutes(totalMinutes) + " total";
    el.count.textContent = summary;

    el.empty.hidden = results.length !== 0;
    el.activeFilters.textContent = describeFilters();
  }

  function describeFilters() {
    var bits = [];
    if (state.q) bits.push('search "' + state.q + '"');
    if (state.repo.length) bits.push(state.repo.length + " course(s)");
    if (state.level.length) bits.push("level " + state.level.join(", "));
    if (state.duration) bits.push(state.duration === "60+" ? "60+ min" : "\u2264 " + state.duration + " min");
    if (state.status.length) bits.push("status " + state.status.join(", "));
    if (state.topic.length) bits.push(state.topic.length + " topic(s)");
    return bits.length ? "Filters: " + bits.join(" \u00b7 ") : "No filters applied";
  }

  /* ---------------- events ---------------- */

  function selectedValues(select) {
    return Array.prototype.filter
      .call(select.options, function (o) {
        return o.selected;
      })
      .map(function (o) {
        return o.value;
      });
  }

  function onFilterChange() {
    MULTI.forEach(function (key) {
      // Options hidden by the topic search must keep their selection.
      var visible = selectedValues(el[key]);
      if (key === "topic" && el.topicSearch.value.trim()) {
        var shown = Array.prototype.map.call(el.topic.options, function (o) {
          return o.value;
        });
        var hiddenSelected = state.topic.filter(function (v) {
          return shown.indexOf(v) === -1;
        });
        visible = visible.concat(hiddenSelected);
      }
      state[key] = visible;
    });
    state.duration = el.duration.value;
    writeUrl(false);
    render();
  }

  function clearAll() {
    state = { q: "", repo: [], level: [], duration: "", status: [], topic: [] };
    el.q.value = "";
    el.topicSearch.value = "";
    writeUrl(false);
    render();
    el.q.focus();
  }

  function wire() {
    el.q.addEventListener(
      "input",
      debounce(function () {
        state.q = el.q.value.trim();
        writeUrl(true);
        render();
      }, 200)
    );

    MULTI.forEach(function (key) {
      el[key].addEventListener("change", onFilterChange);
    });
    el.duration.addEventListener("change", onFilterChange);

    el.topicSearch.addEventListener(
      "input",
      debounce(function () {
        renderSelect("topic");
      }, 150)
    );

    el.form.addEventListener("submit", function (e) {
      e.preventDefault();
    });

    el.clear.addEventListener("click", clearAll);
    Array.prototype.forEach.call(document.querySelectorAll("[data-clear]"), function (b) {
      b.addEventListener("click", clearAll);
    });

    window.addEventListener("popstate", function () {
      readUrl();
      el.q.value = state.q;
      render();
    });
  }

  /* ---------------- boot ---------------- */

  function showError(message) {
    el.error.hidden = false;
    el.errorDetail.textContent = message;
    el.count.textContent = "";
    el.empty.hidden = true;
  }

  fetch(DATA_URL, { cache: "no-cache" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + DATA_URL);
      return res.json();
    })
    .then(function (data) {
      labs = Array.isArray(data.labs) ? data.labs : [];
      meta = data;

      if (!labs.length) {
        showError("The index loaded but contains no labs.");
        return;
      }

      OPTIONS = optionLists();
      readUrl();
      el.q.value = state.q;
      wire();
      render();
      writeUrl(true);

      var repoCount = (meta.repos || []).length;
      el.freshness.textContent =
        "Index generated " +
        formatDate(meta.generated_at) +
        " \u00b7 " +
        labs.length +
        " labs from " +
        repoCount +
        " repositories \u00b7 refreshed daily.";
      el.freshness.title = (meta.repos || [])
        .map(function (r) {
          return r.repo + ": " + r.labCount;
        })
        .join("\n");
    })
    .catch(function (err) {
      showError(
        err.message +
          ". If you are opening index.html directly from disk, run a local web server instead (npm run serve)."
      );
    });
})();

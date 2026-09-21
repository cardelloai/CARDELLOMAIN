/* Cardello — guided card-creation wizard
   Plain JS, no build step. Talks to /api/* serverless functions. */

(function () {
  "use strict";

  const state = {
    step: 0,
    occasion: null,
    occasionOther: "",
    relationship: null,
    relationshipOther: "",
    recipientName: "",
    details: "",
    tone: null,
    photoDataUrl: null,
    photoFile: null,
    groupPhotos: [],       // [{dataUrl, name}] — used when relationship === "group"
    designs: [],           // [{id, url}]
    selectedDesignId: null,
    message: "",
    cardSize: "standard",  // standard | large
    finish: "matte",       // matte | glossy
  };

  const OCCASIONS = [
    { id: "birthday", label: "Birthday", emoji: "🎂" },
    { id: "christmas", label: "Christmas", emoji: "🎄" },
    { id: "anniversary", label: "Anniversary", emoji: "💍" },
    { id: "congratulations", label: "Congratulations", emoji: "🎉" },
    { id: "thank-you", label: "Thank You", emoji: "🙏" },
    { id: "get-well", label: "Get Well Soon", emoji: "🌻" },
    { id: "sympathy", label: "Sympathy", emoji: "🕊️" },
    { id: "holiday", label: "Other Holiday", emoji: "🎆" },
    { id: "new-baby", label: "New Baby", emoji: "👶" },
    { id: "wedding", label: "Wedding", emoji: "💐" },
    { id: "retirement", label: "Retirement", emoji: "🌴" },
    { id: "pet", label: "Pet's Birthday", emoji: "🐾" },
    { id: "just-because", label: "Just Because", emoji: "💌" },
    { id: "other", label: "Something Else", emoji: "✨" },
  ];

  const RELATIONSHIPS = [
    { id: "mom", label: "My Mom", emoji: "👩" },
    { id: "dad", label: "My Dad", emoji: "👨" },
    { id: "spouse", label: "My Spouse / Partner", emoji: "💑" },
    { id: "grandparent", label: "My Grandparent", emoji: "👵" },
    { id: "child", label: "My Son / Daughter", emoji: "🧒" },
    { id: "sibling", label: "My Sibling", emoji: "👫" },
    { id: "friend", label: "A Friend", emoji: "🤝" },
    { id: "group", label: "Family or Friends (Group)", emoji: "👨‍👩‍👧‍👦" },
    { id: "other", label: "Someone Else", emoji: "❤️" },
  ];

  const TONES = [
    { id: "funny", label: "Funny & Playful", emoji: "😄" },
    { id: "heartfelt", label: "Heartfelt & Warm", emoji: "🥰" },
    { id: "elegant", label: "Elegant & Classic", emoji: "🌹" },
  ];

  const CARD_PRICE = { standard: 16.99, large: 22.99 };
  const FINISH_ADD = { matte: 0, glossy: 2.0 };

  // ---------- Save-in-progress (same browser/device only) ----------
  // Autosaves the wizard's answers to this browser as the customer goes,
  // so closing the tab or accidentally navigating away doesn't lose a
  // card that's mid-way through. This is browser storage, not an account:
  // it only resumes on the same device/browser, and never leaves this
  // computer. The raw uploaded photo is deliberately left out (it's a
  // large base64 string that risks hitting storage limits) — a customer
  // resuming from before their designs were generated just re-adds the
  // photo, which the photo step already handles gracefully.
  const DRAFT_KEY = "cardello_draft_v1";
  const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

  function saveDraft() {
    try {
      const draft = {
        step: state.step,
        occasion: state.occasion,
        occasionOther: state.occasionOther,
        relationship: state.relationship,
        relationshipOther: state.relationshipOther,
        recipientName: state.recipientName,
        details: state.details,
        tone: state.tone,
        designs: state.designs,
        selectedDesignId: state.selectedDesignId,
        message: state.message,
        cardSize: state.cardSize,
        finish: state.finish,
        savedAt: Date.now(),
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (err) {
      // Storage can fail (private browsing, full quota, disabled) — the
      // wizard still works fine without autosave, it just won't offer a
      // "welcome back" resume next time.
      console.warn("Could not save draft:", err);
    }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw);
      if (!draft || !draft.occasion) return null;
      if (Date.now() - (draft.savedAt || 0) > DRAFT_MAX_AGE_MS) return null;
      return draft;
    } catch {
      return null;
    }
  }

  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (err) {
      // Nothing to do — worst case a stale draft lingers until it expires.
    }
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => {
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else if (c) node.appendChild(c);
    });
    return node;
  }

  const panel = document.getElementById("stepPanel");
  const progressFill = document.getElementById("progressFill");

  const STEPS = [
    renderOccasion,
    renderRelationship,
    renderDetails,
    renderPhoto,
    renderGenerating,
    renderPickDesign,
    renderCustomize,
    renderCheckoutRedirect,
  ];

  function setProgress() {
    const pct = Math.round((state.step / (STEPS.length - 1)) * 100);
    progressFill.style.width = pct + "%";
  }

  function goTo(stepIndex) {
    state.step = stepIndex;
    setProgress();
    panel.innerHTML = "";
    STEPS[stepIndex]();
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Steps 4 (generating) and 7 (checkout redirect) are transient — they
    // auto-advance or navigate away on their own, so saving a draft that
    // points at one of them would resume into a dead loading screen.
    // Every other step reflects a real, stable point the customer chose.
    if (stepIndex !== 4 && stepIndex !== 7) saveDraft();
  }

  function next() { goTo(state.step + 1); }
  function back() { goTo(Math.max(0, state.step - 1)); }

  function navRow({ onBack, onNext, nextLabel, nextDisabled }) {
    const row = el("div", { class: "nav-row" }, [
      state.step > 0
        ? el("button", { class: "btn btn-secondary" }, ["Back"])
        : el("span", { class: "spacer" }),
      el("span", { class: "spacer" }),
      el("button", { class: "btn btn-primary" }, [nextLabel || "Continue"]),
    ]);
    const backBtn = row.querySelector(".btn-secondary");
    const nextBtn = row.querySelector(".btn-primary");
    if (backBtn) backBtn.addEventListener("click", onBack || back);
    if (nextBtn) {
      nextBtn.addEventListener("click", onNext || next);
      if (nextDisabled) nextBtn.disabled = true;
    }
    return row;
  }

  function choiceGrid(options, selectedId, onSelect) {
    const grid = el("div", { class: "choice-grid" });
    options.forEach((opt) => {
      const card = el(
        "div",
        { class: "choice-card" + (selectedId === opt.id ? " selected" : "") },
        [el("span", { class: "emoji" }, [opt.emoji]), el("span", {}, [opt.label])]
      );
      card.addEventListener("click", () => onSelect(opt.id));
      grid.appendChild(card);
    });
    return grid;
  }

  // ---------- Step 1: Occasion ----------
  function renderOccasion() {
    panel.appendChild(el("p", { class: "step-eyebrow" }, ["Step 1 of 7"]));
    panel.appendChild(el("h2", { class: "step-title" }, ["What's the occasion?"]));
    panel.appendChild(el("p", { class: "step-sub" }, ["Pick the one that fits best."]));

    let selected = state.occasion;
    const grid = choiceGrid(OCCASIONS, selected, (id) => {
      state.occasion = id;
      goTo(state.step); // re-render to show selection + continue button state
    });
    panel.appendChild(grid);

    if (state.occasion === "other") {
      const field = el("div", { class: "field", style: "margin-top:24px;" }, [
        el("label", {}, ["What's the occasion?"]),
        el("input", { type: "text", id: "occasionOtherInput", value: state.occasionOther || "" }),
      ]);
      panel.appendChild(field);
      field.querySelector("input").addEventListener("input", (e) => {
        state.occasionOther = e.target.value;
      });
    }

    const canContinue = state.occasion && (state.occasion !== "other" || state.occasionOther.trim());
    panel.appendChild(
      navRow({ nextDisabled: !canContinue, onNext: canContinue ? next : (e) => e.preventDefault() })
    );
  }

  // ---------- Step 2: Relationship ----------
  function renderRelationship() {
    panel.appendChild(el("p", { class: "step-eyebrow" }, ["Step 2 of 7"]));
    panel.appendChild(el("h2", { class: "step-title" }, ["Who is this card for?"]));
    panel.appendChild(el("p", { class: "step-sub" }, ["Choose who they are to you."]));

    const grid = choiceGrid(RELATIONSHIPS, state.relationship, (id) => {
      state.relationship = id;
      goTo(state.step);
    });
    panel.appendChild(grid);

    if (state.relationship === "other") {
      const field = el("div", { class: "field", style: "margin-top:24px;" }, [
        el("label", {}, ["How would you describe them?"]),
        el("input", { type: "text", id: "relOtherInput", value: state.relationshipOther || "", placeholder: "e.g. My neighbor" }),
      ]);
      panel.appendChild(field);
      field.querySelector("input").addEventListener("input", (e) => {
        state.relationshipOther = e.target.value;
      });
    }

    const nameField = el("div", { class: "field", style: "margin-top:24px;" }, [
      el("label", {}, ["What's their first name? (optional)"]),
      el("input", { type: "text", id: "nameInput", value: state.recipientName || "", placeholder: "e.g. Robert" }),
    ]);
    panel.appendChild(nameField);
    nameField.querySelector("input").addEventListener("input", (e) => {
      state.recipientName = e.target.value;
    });

    const canContinue = state.relationship && (state.relationship !== "other" || state.relationshipOther.trim());
    panel.appendChild(navRow({ nextDisabled: !canContinue }));
  }

  // ---------- Step 3: Details & tone ----------
  function getDefaultTone(occasion) {
    // Sympathy cards shouldn't default to jokes — everything else defaults
    // to funny, since that's the style Cardello is built around.
    return occasion === "sympathy" ? "heartfelt" : "funny";
  }

  function renderDetails() {
    if (!state.tone) state.tone = getDefaultTone(state.occasion);

    panel.appendChild(el("p", { class: "step-eyebrow" }, ["Step 3 of 7"]));
    panel.appendChild(el("h2", { class: "step-title" }, ["Tell us a little about them"]));
    panel.appendChild(el("p", { class: "step-sub" }, [
      "A hobby, something they love, or a fun detail — this helps our AI design a card that feels like them.",
    ]));

    const field = el("div", { class: "field" }, [
      el("label", {}, ["What do they love, or what makes them special?"]),
      el("textarea", { id: "detailsInput", placeholder: "e.g. He loves fishing, terrible dad jokes, and his golden retriever Max." }, [state.details || ""]),
      el("p", { class: "hint" }, ["A sentence or two is plenty."]),
    ]);
    panel.appendChild(field);
    field.querySelector("textarea").addEventListener("input", (e) => {
      state.details = e.target.value;
    });

    panel.appendChild(el("div", { class: "field" }, [el("label", {}, ["What feeling should the card have?"])]));
    const grid = choiceGrid(TONES, state.tone, (id) => {
      state.tone = id;
      goTo(state.step);
    });
    panel.appendChild(grid);

    const canContinue = !!state.tone;
    panel.appendChild(navRow({ nextDisabled: !canContinue }));
  }

  // ---------- Step 4: Photo upload ----------
  function renderPhoto() {
    if (state.relationship === "group") {
      renderGroupPhotos();
      return;
    }

    panel.appendChild(el("p", { class: "step-eyebrow" }, ["Step 4 of 7"]));
    panel.appendChild(el("h2", { class: "step-title" }, ["Add a photo"]));
    panel.appendChild(el("p", { class: "step-sub" }, [
      "Upload one clear photo of them. Our AI will use it to design your card.",
    ]));

    const fileInput = el("input", { type: "file", accept: "image/*", class: "visually-hidden", id: "photoFileInput" });
    const box = el("div", { class: "upload-box" }, [
      el("div", { class: "icon" }, ["📷"]),
      el("p", {}, ["Tap here to choose a photo"]),
      el("p", { class: "small" }, ["JPG or PNG, from your camera roll or files"]),
    ]);
    box.addEventListener("click", () => fileInput.click());

    panel.appendChild(box);
    panel.appendChild(fileInput);

    const previewWrap = el("div", { id: "previewWrap" });
    panel.appendChild(previewWrap);

    function renderPreview() {
      previewWrap.innerHTML = "";
      if (state.photoDataUrl) {
        const row = el("div", { class: "upload-preview" }, [
          el("img", { src: state.photoDataUrl, alt: "Selected photo" }),
          el("button", { class: "btn btn-link" }, ["Choose a different photo"]),
        ]);
        row.querySelector("button").addEventListener("click", () => fileInput.click());
        previewWrap.appendChild(row);
      }
    }
    renderPreview();

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      state.photoFile = file;
      const reader = new FileReader();
      reader.onload = () => {
        state.photoDataUrl = reader.result;
        renderPreview();
        updateContinueState();
      };
      reader.readAsDataURL(file);
    });

    const nav = navRow({ nextDisabled: !state.photoDataUrl, onNext: () => next() });
    panel.appendChild(nav);

    function updateContinueState() {
      const nextBtn = nav.querySelector(".btn-primary");
      nextBtn.disabled = !state.photoDataUrl;
    }
  }

  // ---------- Step 4b: Group photo upload (Family or Friends) ----------
  const MAX_GROUP_PHOTOS = 8;

  function renderGroupPhotos() {
    panel.appendChild(el("p", { class: "step-eyebrow" }, ["Step 4 of 7"]));
    panel.appendChild(el("h2", { class: "step-title" }, ["Add everyone's photo"]));
    panel.appendChild(el("p", { class: "step-sub" }, [
      "Upload a clear photo of each person to include — one face per photo works best. Add up to " +
        MAX_GROUP_PHOTOS +
        ".",
    ]));

    const fileInput = el("input", {
      type: "file",
      accept: "image/*",
      multiple: "multiple",
      class: "visually-hidden",
      id: "groupPhotoFileInput",
    });

    const box = el("div", { class: "upload-box" }, [
      el("div", { class: "icon" }, ["👨‍👩‍👧‍👦"]),
      el("p", {}, ["Tap here to add photos"]),
      el("p", { class: "small" }, ["You can select multiple photos at once, or add them one at a time"]),
    ]);
    box.addEventListener("click", () => fileInput.click());

    panel.appendChild(box);
    panel.appendChild(fileInput);

    const grid = el("div", { class: "group-photo-grid" });
    panel.appendChild(grid);

    const nav = navRow({ nextDisabled: state.groupPhotos.length === 0 });
    panel.appendChild(nav);

    function updateContinueState() {
      nav.querySelector(".btn-primary").disabled = state.groupPhotos.length === 0;
    }

    function renderGrid() {
      grid.innerHTML = "";
      state.groupPhotos.forEach((photo, i) => {
        const tile = el("div", { class: "group-photo-tile" }, [
          el("img", { src: photo.dataUrl, alt: "Person " + (i + 1) }),
          el("button", { class: "group-photo-remove", type: "button", title: "Remove" }, ["✕"]),
        ]);
        tile.querySelector("button").addEventListener("click", () => {
          state.groupPhotos.splice(i, 1);
          renderGrid();
          updateContinueState();
        });
        grid.appendChild(tile);
      });
      if (state.groupPhotos.length >= MAX_GROUP_PHOTOS) {
        box.classList.add("upload-box-disabled");
      } else {
        box.classList.remove("upload-box-disabled");
      }
    }
    renderGrid();

    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []).slice(
        0,
        Math.max(0, MAX_GROUP_PHOTOS - state.groupPhotos.length)
      );
      if (!files.length) return;

      Promise.all(
        files.map(
          (file) =>
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(file);
            })
        )
      ).then((dataUrls) => {
        dataUrls.forEach((dataUrl) => state.groupPhotos.push({ dataUrl }));
        renderGrid();
        updateContinueState();
      });

      fileInput.value = "";
    });
  }

  // ---------- Step 5: Generating (calls API) ----------
  function renderGenerating() {
    panel.appendChild(
      el("div", { class: "loading-wrap" }, [
        el("div", { class: "spinner" }),
        el("h2", {}, ["Creating your card designs..."]),
        el("p", {}, ["This usually takes about 20–30 seconds. Please don't close this page."]),
      ])
    );

    const occasionLabel =
      state.occasion === "other" ? state.occasionOther : OCCASIONS.find((o) => o.id === state.occasion).label;
    const relationshipLabel =
      state.relationship === "other"
        ? state.relationshipOther
        : RELATIONSHIPS.find((r) => r.id === state.relationship).label;

    const isGroup = state.relationship === "group";

    fetch("/api/generate-cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        occasion: occasionLabel,
        relationship: relationshipLabel,
        recipientName: state.recipientName,
        details: state.details,
        tone: state.tone,
        photoDataUrl: isGroup ? null : state.photoDataUrl,
        groupPhotoDataUrls: isGroup ? state.groupPhotos.map((p) => p.dataUrl) : undefined,
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("Generation failed");
        return r.json();
      })
      .then((data) => {
        state.designs = data.designs || [];
        state.message = data.suggestedMessage || "";
        goTo(state.step + 1);
      })
      .catch(() => {
        panel.innerHTML = "";
        panel.appendChild(el("div", { class: "alert" }, [
          "We had trouble creating your designs. Please try again — no charge has been made.",
        ]));
        const retry = el("button", { class: "btn btn-primary" }, ["Try Again"]);
        retry.addEventListener("click", () => goTo(state.step));
        panel.appendChild(retry);
        const backBtn = el("button", { class: "btn btn-secondary", style: "margin-left:12px;" }, ["Back"]);
        backBtn.addEventListener("click", back);
        panel.appendChild(backBtn);
      });
  }

  // ---------- Step 6: Pick a design ----------
  function renderPickDesign() {
    panel.appendChild(el("p", { class: "step-eyebrow" }, ["Step 5 of 7"]));
    panel.appendChild(el("h2", { class: "step-title" }, ["Pick your favorite"]));
    panel.appendChild(el("p", { class: "step-sub" }, ["Tap a design to select it."]));

    const grid = el("div", { class: "design-grid" });
    (state.designs.length ? state.designs : placeholderDesigns()).forEach((d, i) => {
      const opt = el(
        "div",
        { class: "design-option" + (state.selectedDesignId === d.id ? " selected" : "") },
        [el("img", { src: d.url, alt: "Card design option " + (i + 1) }), el("div", { class: "label" }, ["Design " + (i + 1)])]
      );
      opt.addEventListener("click", () => {
        state.selectedDesignId = d.id;
        goTo(state.step);
      });
      grid.appendChild(opt);
    });
    panel.appendChild(grid);

    panel.appendChild(navRow({ nextDisabled: !state.selectedDesignId }));
  }

  function placeholderDesigns() {
    // Fallback so the flow is browsable before an image API key is configured.
    return [1, 2, 3, 4].map((n) => ({ id: "placeholder-" + n, url: "assets/logo.png" }));
  }

  // Makes the live 3D card preview follow the cursor (or a finger, on
  // touch), tilting the card as you move over it — like the "spin around
  // the product" preview you see on sites like Vistaprint. Purely CSS
  // transforms driven by pointer position; no extra image or library.
  function attachCard3dTilt(scene, cardEl) {
    const BASE_TILT_X = 4; // resting tilt, matches the CSS default pose
    const MAX_TILT_Y = 28; // left/right, following horizontal movement
    const MAX_TILT_X = 12; // up/down, following vertical movement

    function setTilt(rotateX, rotateY) {
      cardEl.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    }
    function resetTilt() {
      setTilt(BASE_TILT_X, 0);
    }
    function applyFromPoint(clientX, clientY) {
      const rect = scene.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const relX = (clientX - rect.left) / rect.width; // 0 (left) .. 1 (right)
      const relY = (clientY - rect.top) / rect.height; // 0 (top) .. 1 (bottom)
      const rotateY = (relX - 0.5) * 2 * MAX_TILT_Y;
      const rotateX = BASE_TILT_X - (relY - 0.5) * 2 * MAX_TILT_X;
      setTilt(rotateX, rotateY);
    }

    resetTilt();

    scene.addEventListener("mousemove", (e) => applyFromPoint(e.clientX, e.clientY));
    scene.addEventListener("mouseleave", resetTilt);

    scene.addEventListener(
      "touchmove",
      (e) => {
        const touch = e.touches && e.touches[0];
        if (!touch) return;
        applyFromPoint(touch.clientX, touch.clientY);
        e.preventDefault(); // avoid the page scrolling while looking around the card
      },
      { passive: false }
    );
    scene.addEventListener("touchend", resetTilt);
    scene.addEventListener("touchcancel", resetTilt);
  }

  // Shrinks the inside-message text to fit the little card preview instead
  // of overflowing or looking oversized for a short message. Steps the font
  // size down until the text fits its page, then stops — cheap since it's
  // only ever a sentence or two.
  function fitMessageText(messageEl) {
    const MAX_FONT = 13;
    const MIN_FONT = 8;
    const container = messageEl.parentElement;
    if (!container) return;
    let fontSize = MAX_FONT;
    messageEl.style.fontSize = fontSize + "px";
    while (fontSize > MIN_FONT && messageEl.scrollHeight > container.clientHeight) {
      fontSize -= 0.5;
      messageEl.style.fontSize = fontSize + "px";
    }
  }

  // ---------- Step 7: Customize message + size ----------
  function renderCustomize() {
    panel.appendChild(el("p", { class: "step-eyebrow" }, ["Step 6 of 7"]));
    panel.appendChild(el("h2", { class: "step-title" }, ["Make it yours"]));
    panel.appendChild(el("p", { class: "step-sub" }, ["Edit the message inside, and choose your card style."]));

    const design = (state.designs.length ? state.designs : placeholderDesigns()).find(
      (d) => d.id === state.selectedDesignId
    ) || placeholderDesigns()[0];

    const layout = el("div", { class: "preview-layout" });

    const pageSizeClass = state.cardSize === "large" ? " size-large" : "";
    const messageEl = el("p", { class: "card-3d-message" }, [state.message || "Your message will appear here as you type..."]);
    const card3d = el("div", { class: "card-3d" }, [
      el("div", { class: "card-3d-page inside" + pageSizeClass }, [messageEl]),
      el("div", { class: "card-3d-page front" + pageSizeClass }, [
        el("img", { src: design.url, alt: "Your selected card design" }),
      ]),
    ]);
    const scene = el("div", { class: "card-3d-scene" }, [card3d]);
    const mock = el("div", { class: "card-mock" }, [
      scene,
      el("p", { class: "card-3d-caption" }, ["Move your cursor over the card to look around it"]),
    ]);
    layout.appendChild(mock);
    attachCard3dTilt(scene, card3d);
    fitMessageText(messageEl);

    const formCol = el("div", {});
    const msgField = el("div", { class: "field" }, [
      el("label", {}, ["Your message inside the card"]),
      el("textarea", { id: "msgInput" }, [state.message || ""]),
    ]);
    formCol.appendChild(msgField);
    msgField.querySelector("textarea").addEventListener("input", (e) => {
      state.message = e.target.value;
      messageEl.textContent = state.message.trim() || "Your message will appear here as you type...";
      fitMessageText(messageEl);
    });

    formCol.appendChild(el("div", { class: "field" }, [el("label", {}, ["Card size"])]));
    const sizeRow = el("div", { class: "option-row" }, [
      pill("Standard (5x7\")", state.cardSize === "standard", () => {
        state.cardSize = "standard";
        goTo(state.step);
      }),
      pill("Large (7x10\")", state.cardSize === "large", () => {
        state.cardSize = "large";
        goTo(state.step);
      }),
    ]);
    formCol.appendChild(sizeRow);

    formCol.appendChild(el("div", { class: "field", style: "margin-top:20px;" }, [el("label", {}, ["Finish"])]));
    const finishRow = el("div", { class: "option-row" }, [
      pill("Matte", state.finish === "matte", () => {
        state.finish = "matte";
        goTo(state.step);
      }),
      pill("Glossy (+$2.00)", state.finish === "glossy", () => {
        state.finish = "glossy";
        goTo(state.step);
      }),
    ]);
    formCol.appendChild(finishRow);

    const total = (CARD_PRICE[state.cardSize] + FINISH_ADD[state.finish]).toFixed(2);
    formCol.appendChild(
      el("div", { class: "price-row" }, [el("span", {}, ["Total"]), el("span", {}, ["$" + total])])
    );

    layout.appendChild(formCol);
    panel.appendChild(layout);

    panel.appendChild(navRow({ nextLabel: "Continue to Shipping & Payment", nextDisabled: !state.message.trim() }));
  }

  function pill(label, selected, onClick) {
    const p = el("div", { class: "pill-choice" + (selected ? " selected" : "") }, [label]);
    p.addEventListener("click", onClick);
    return p;
  }

  // ---------- Step 8: Redirect to Stripe Checkout ----------
  function renderCheckoutRedirect() {
    panel.appendChild(
      el("div", { class: "loading-wrap" }, [
        el("div", { class: "spinner" }),
        el("h2", {}, ["Taking you to secure checkout..."]),
        el("p", {}, ["You'll enter your shipping address and payment on the next screen."]),
      ])
    );

    const design = (state.designs.length ? state.designs : placeholderDesigns()).find(
      (d) => d.id === state.selectedDesignId
    ) || placeholderDesigns()[0];
    const total = (CARD_PRICE[state.cardSize] + FINISH_ADD[state.finish]).toFixed(2);

    fetch("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        designUrl: design.url,
        message: state.message,
        cardSize: state.cardSize,
        finish: state.finish,
        amount: total,
        recipientName: state.recipientName,
        occasion: state.occasion === "other" ? state.occasionOther : state.occasion,
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("Checkout session failed");
        return r.json();
      })
      .then((data) => {
        if (data.url) window.location.href = data.url;
        else throw new Error("No checkout URL returned");
      })
      .catch(() => {
        panel.innerHTML = "";
        panel.appendChild(
          el("div", { class: "alert" }, ["We couldn't start checkout. Please try again — no charge has been made."])
        );
        const retry = el("button", { class: "btn btn-primary" }, ["Try Again"]);
        retry.addEventListener("click", () => goTo(state.step));
        panel.appendChild(retry);
      });
  }

  // Shown on page load when a saved draft exists — lets the customer pick
  // up their in-progress card instead of silently losing it, or deliberately
  // start over. Doesn't use the STEPS array since it isn't really a wizard
  // step, just a fork before the wizard resumes.
  function renderResumeBanner(draft, onContinue, onStartOver) {
    panel.innerHTML = "";
    const occasionMeta = OCCASIONS.find((o) => o.id === draft.occasion);
    const occasionLabel = draft.occasion === "other" ? draft.occasionOther || "your" : occasionMeta ? occasionMeta.label : "your";
    const who = draft.recipientName ? ` for ${draft.recipientName}` : "";

    panel.appendChild(el("p", { class: "step-eyebrow" }, ["Welcome back"]));
    panel.appendChild(el("h2", { class: "step-title" }, ["Pick up where you left off?"]));
    panel.appendChild(
      el("p", { class: "step-sub" }, [
        `We saved your ${occasionLabel} card${who} in progress. Continue it, or start a brand new card.`,
      ])
    );

    const row = el("div", { class: "nav-row" }, [
      el("button", { class: "btn btn-secondary" }, ["Start a New Card"]),
      el("span", { class: "spacer" }),
      el("button", { class: "btn btn-primary" }, ["Continue My Card"]),
    ]);
    row.querySelector(".btn-secondary").addEventListener("click", onStartOver);
    row.querySelector(".btn-primary").addEventListener("click", onContinue);
    panel.appendChild(row);
  }

  // If arriving from an occasion-specific link (e.g. an ad landing on
  // create.html?occasion=birthday), pre-select it and skip straight to
  // step 2 so the customer isn't asked something we already know. A saved
  // draft takes priority over that, since resuming real progress matters
  // more than a landing-page shortcut.
  (function initFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("occasion");

    function startFresh() {
      if (requested && OCCASIONS.some((o) => o.id === requested)) {
        state.occasion = requested;
        goTo(1);
      } else {
        goTo(0);
      }
    }

    const draft = loadDraft();
    if (!draft) {
      startFresh();
      return;
    }

    renderResumeBanner(
      draft,
      () => {
        // Continue: restore every saved answer, then resume at the saved
        // step — except the two transient steps, which never get saved as
        // the resume point in the first place (see goTo), so this is just
        // a defensive fallback in case of an older/unexpected draft shape.
        Object.assign(state, draft);
        let resumeStep = state.step;
        if (resumeStep == null || resumeStep === 4 || resumeStep === 7) {
          resumeStep = state.designs && state.designs.length ? 5 : 3;
        }
        goTo(resumeStep);
      },
      () => {
        clearDraft();
        startFresh();
      }
    );
  })();
})();

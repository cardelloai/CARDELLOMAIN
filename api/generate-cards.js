/**
 * POST /api/generate-cards
 *
 * Turns the customer's answers + uploaded photo into 4 card design options,
 * plus a suggested inside-card message.
 *
 * Design style: bold, photorealistic "poster" cards — the customer's own
 * photo, kept realistic (not cartoonified), staged in a fun scene related to
 * their interests, with a big headline ("Happy Birthday!"), a short personal
 * subheading, and a few punchy caption/prop labels baked into the image
 * (think: novelty birthday card you'd find in a card shop, personalized).
 *
 * This happens in two steps:
 *   1. Ask a text model to write the exact headline / subheading / caption
 *      copy, personalized from the customer's answers — and to dream up a
 *      big, silly, literal scene concept (for the "Funny" tone) or a warm,
 *      natural one (for other tones).
 *   2. Ask an image model to render a photorealistic scene around the
 *      uploaded photo with that exact copy as bold poster typography.
 *
 * IMPORTANT CAVEAT: image models are not perfectly reliable at rendering
 * multiple short text strings without typos or garbled letters — it's much
 * better than it used to be, but not perfect. Generate a batch of real test
 * cards before launch and check the on-image text carefully; consider
 * regenerating (or letting the customer regenerate) any design where the
 * text came out wrong rather than shipping it as-is.
 *
 * Uses OpenAI's image + chat APIs directly via fetch — no SDK required, so
 * this deploys with zero npm install.
 *
 * Required env var: OPENAI_API_KEY
 */

// Different typography/poster treatments — the photo and copy stay the
// same, only the visual "card shop style" changes between options.
const STYLE_VARIANTS = [
  "rustic wood-sign poster style: distressed wooden headline signs, warm golden-hour lighting, outdoorsy garage/cabin backdrop",
  "clean bold modern poster style: crisp sans-serif headline type, bright saturated colors, simple uncluttered background",
  "vintage Americana poster style: hand-painted lettering, retro color grading, nostalgic diner/roadside-sign feel",
  "playful comic-bold poster style: thick outlined lettering, punchy contrast colors, fun oversized prop callouts",
];

const TONE_WORDS = {
  funny: "funny, playful, tongue-in-cheek",
  heartfelt: "warm, heartfelt, sincere",
  elegant: "elegant, classic, understated",
};

/** Step 1: have a text model write the exact on-card copy, plus dream up the
 *  big, silly, literal scene concept the image model will render. */
async function generateCopy({ occasion, relationship, recipientName, details, tone }) {
  const who = recipientName || relationship || "this person";
  const toneWord = TONE_WORDS[tone] || TONE_WORDS.heartfelt;
  const isFunny = tone === "funny" || !tone;

  const sceneInstruction = isFunny
    ? `- "sceneIdea": ONE vivid sentence describing a big, silly, LITERALLY exaggerated action scene that combines ` +
      `the occasion and what the customer told us about them. Take their interest and blow it up to an absurd, ` +
      `larger-than-life scale — don't just show them doing the hobby normally, put them INSIDE an over-the-top ` +
      `version of it. Examples of the style we want: if it's Christmas, "riding a giant reindeer through a snowy ` +
      `night sky like Santa, sack of presents flying behind them"; if they love fishing and beer, "riding on the ` +
      `back of a massive leaping fish through a lake, a frosty beer held high in one hand, sunglasses on, huge grin"; ` +
      `if they love golf, "swinging a golf club the size of a telephone pole, ball rocketing past the moon". Be ` +
      `genuinely funny and visual, not just a normal photo of the activity — the sillier and more literal, the better.`
    : `- "sceneIdea": ONE sentence describing a warm, natural scene that ties the occasion to what the customer told ` +
      `us about them (their hobby, interest, or what makes them special), staged like a nice, personal photograph — ` +
      `not absurd, just thoughtful and specific to them.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content:
            `You are writing the on-card copy AND the scene concept for a personalized novelty greeting card poster, ` +
            `for a "${occasion || "special"}" occasion, ${toneWord} in tone. ` +
            `The card is for the customer's ${relationship || "loved one"}${recipientName ? ` (${recipientName})` : ""}. ` +
            `What the customer told us about them: "${details || "no extra details given"}". ` +
            `Return strict JSON with these fields:\n` +
            sceneInstruction +
            `\n- "headline": a short, punchy 2-5 word headline like a card shop cover would have (e.g. "Happy Birthday!"). Keep it under 25 characters.\n` +
            `- "subheading": one short punchy line (under 60 characters) personalized to them.\n` +
            `- "captions": an array of exactly 4 very short prop/sign labels (2-4 words each, ALL CAPS, like novelty-card callouts — e.g. "GRILL CHILL REPEAT", "BEST BUDDY ALWAYS") that riff on the details given and the scene. If no specific interests were given, make them generic but fitting the occasion.\n` +
            `Keep every string short — these get rendered as typography on an image, so brevity matters. No emoji.`,
        },
      ],
      temperature: 1.0,
    }),
  });

  if (!resp.ok) {
    // Fall back to safe generic copy rather than failing the whole request.
    return {
      headline: `Happy ${occasion || "Day"}!`,
      subheading: "Made just for you.",
      captions: ["MADE WITH LOVE", "JUST FOR YOU", "CHEERS TO YOU", "ENJOY THE DAY"],
      sceneIdea: "",
    };
  }

  const data = await resp.json();
  try {
    const parsed = JSON.parse(data.choices[0].message.content);
    return {
      headline: parsed.headline || `Happy ${occasion || "Day"}!`,
      subheading: parsed.subheading || "",
      captions: Array.isArray(parsed.captions) ? parsed.captions.slice(0, 4) : [],
      sceneIdea: parsed.sceneIdea || "",
    };
  } catch {
    return {
      headline: `Happy ${occasion || "Day"}!`,
      subheading: "Made just for you.",
      captions: [],
      sceneIdea: "",
    };
  }
}

function buildScenePrompt({ occasion, relationship, recipientName, details, tone, copy, isGroup, groupCount }) {
  const who = recipientName ? `${relationship} named ${recipientName}` : relationship || "loved one";
  const about = details && details.trim() ? details.trim() : "a wonderful, one-of-a-kind person";
  const toneWord = TONE_WORDS[tone] || TONE_WORDS.heartfelt;
  const isFunny = tone === "funny" || !tone;
  const captionList = copy.captions.length ? copy.captions.map((c) => `"${c}"`).join(", ") : "none";

  const subjectLine = isGroup
    ? `Use the ${groupCount} people in the attached photos as the subjects — keep every one of them ` +
      `photorealistic and clearly recognizable (same face, same likeness) from their own reference photo, ` +
      `do NOT turn them into cartoons or illustrations. Stage the whole group together naturally in one ` +
      `scene, as if they were photographed side by side. They are the customer's ${relationship || "family or friends"}.`
    : `Use the person in the attached photo as the subject — keep them photorealistic and clearly ` +
      `recognizable (same face, same likeness), do NOT turn them into a cartoon or illustration. ` +
      `They are the customer's ${who}.`;

  const sceneLine = copy.sceneIdea
    ? isFunny
      ? `THE SCENE (most important part — commit to this fully): ${copy.sceneIdea}. Really sell the scale and the ` +
        `joke — exaggerated proportions, dynamic action pose, a big goofy grin, dramatic lighting like a movie ` +
        `poster. This should look genuinely funny and larger-than-life, not like a normal posed photo.`
      : `THE SCENE: ${copy.sceneIdea}. Keep it natural, warm, and true to life.`
    : `Stage them in a fun, realistic photo scene fitting the occasion and their interests, with props ` +
      `and background details relevant to what was said about them.`;

  return (
    `Create a personalized novelty greeting card poster for a "${occasion || "special"}" occasion. ` +
    `${subjectLine} About them, from the customer: ${about}. ` +
    `${sceneLine} ` +
    `Overlay this exact bold poster typography on the image, spelled exactly as given: ` +
    `headline text "${copy.headline}" prominently at the top; ` +
    `subheading text "${copy.subheading}" below the headline, smaller; ` +
    `and these short caption/sign labels placed naturally on props or as small signage within the scene: ${captionList}. ` +
    `Render all text crisply, correctly spelled, and legible — this is the most important part of the typography. ` +
    `Overall feeling: ${toneWord}. High-quality commercial photography look, suitable for a printed greeting card cover.`
  );
}

async function generateOneDesign({ prompt, styleDescriptor, photos }) {
  const fullPrompt = `${prompt} Poster treatment: ${styleDescriptor}.`;

  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("prompt", fullPrompt);
  form.append("size", "1024x1536"); // portrait, card-shaped
  form.append("n", "1");

  photos.forEach(({ base64, mimeType }, i) => {
    const buffer = Buffer.from(base64, "base64");
    const blob = new Blob([buffer], { type: mimeType || "image/png" });
    form.append("image[]", blob, `photo-${i}.png`);
  });

  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Image generation failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  const b64 = data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new Error("No image returned from image generation API");
  return `data:image/png;base64,${b64}`;
}

async function generateSuggestedMessage({ occasion, relationship, recipientName, details, tone }) {
  const toneWord = TONE_WORDS[tone] || TONE_WORDS.heartfelt;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content:
            `Write a short, ${toneWord} greeting card message (3-5 sentences max) for a ${occasion || "special"} card. ` +
            `It's from the customer to their ${relationship || "loved one"}${recipientName ? `, ${recipientName}` : ""}. ` +
            `Details about them: ${details || "none provided"}. ` +
            `Write only the message text — no quotation marks, no signature line, no preamble.`,
        },
      ],
      temperature: 0.9,
    }),
  });

  if (!resp.ok) return "";
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message.content.trim()) || "";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({
      error:
        "Image generation isn't configured yet. Set the OPENAI_API_KEY environment variable to enable AI card generation.",
    });
    return;
  }

  try {
    const { occasion, relationship, recipientName, details, tone, photoDataUrl, groupPhotoDataUrls } =
      req.body || {};

    const isGroup = Array.isArray(groupPhotoDataUrls) && groupPhotoDataUrls.length > 0;
    const rawPhotoUrls = isGroup ? groupPhotoDataUrls : photoDataUrl ? [photoDataUrl] : [];

    if (rawPhotoUrls.length === 0) {
      res.status(400).json({ error: isGroup ? "At least one photo is required." : "A photo is required." });
      return;
    }
    if (rawPhotoUrls.length > 8) {
      res.status(400).json({ error: "Please upload at most 8 photos." });
      return;
    }

    const photos = [];
    for (const url of rawPhotoUrls) {
      const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(url || "");
      if (!match) {
        res.status(400).json({ error: "One of the photos could not be read. Please try a different image." });
        return;
      }
      photos.push({ mimeType: match[1], base64: match[2] });
    }

    const [copy, suggestedMessage] = await Promise.all([
      generateCopy({ occasion, relationship, recipientName, details, tone }),
      generateSuggestedMessage({ occasion, relationship, recipientName, details, tone }),
    ]);

    const scenePrompt = buildScenePrompt({
      occasion,
      relationship,
      recipientName,
      details,
      tone,
      copy,
      isGroup,
      groupCount: photos.length,
    });

    const designResults = await Promise.allSettled(
      STYLE_VARIANTS.map((styleDescriptor, i) =>
        generateOneDesign({ prompt: scenePrompt, styleDescriptor, photos }).then((url) => ({
          id: "design-" + i,
          url,
        }))
      )
    );

    const designs = designResults.filter((r) => r.status === "fulfilled").map((r) => r.value);

    if (designs.length === 0) {
      res.status(502).json({ error: "We couldn't generate any designs this time. Please try again." });
      return;
    }

    res.status(200).json({ designs, suggestedMessage, copy });
  } catch (err) {
    console.error("generate-cards error:", err);
    res.status(500).json({ error: "Something went wrong generating your card designs.

import { useState, useEffect, useRef, useMemo } from "react";
import { Volume2, ArrowLeft, Plus } from "lucide-react";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from "firebase/auth";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  collection,
  query,
  where,
  onSnapshot,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";

const APP_VERSION = "2.4";

/* ------------------------------------------------------------------ */
/*  FIREBASE                                                           */
/* ------------------------------------------------------------------ */

const firebaseConfig = {
  apiKey: "AIzaSyBGoyxKeQSsoXyJCr_eJhVcGIh57ihkvOY",
  authDomain: "turbine-english.firebaseapp.com",
  projectId: "turbine-english",
  storageBucket: "turbine-english.firebasestorage.app",
  messagingSenderId: "805180048462",
  appId: "1:805180048462:web:42427a3f3717e52ab02f1f",
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
auth.languageCode = "cs";

let db;
try {
  // Offline cache: progress is saved on the device and synced once online
  db = initializeFirestore(fbApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (e) {
  db = getFirestore(fbApp);
}

/*
  Data model
  users/{uid}            progress, direction, displayName, leaderboardOptIn, extras (own cards in built-in decks)
  decks/{deckId}         ownerId, ownerName, name, desc, shared, cards[]
  leaderboard/{deckId}__{uid}   deckId, uid, displayName, known, total
*/

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */

const LEGACY_KEY = "turbine-flashcards-v1";        // progress saved by version 1.0 on this device
const LEGACY_DONE_KEY = "turbine-legacy-migrated";
const DIR_KEY = "turbine-direction";
const SPEECH_KEY = "turbine-speech-settings";

/* ------------------------------------------------------------------ */
/*  SPEECH                                                             */
/* ------------------------------------------------------------------ */

const speechSettings = { accent: "us", rate: 0.9 };
try {
  const raw = typeof window !== "undefined" && window.localStorage && localStorage.getItem(SPEECH_KEY);
  if (raw) Object.assign(speechSettings, JSON.parse(raw));
} catch (e) {
  /* defaults are fine */
}

function saveSpeechSettings() {
  try { localStorage.setItem(SPEECH_KEY, JSON.stringify(speechSettings)); } catch (e) { /* ignore */ }
}

// Voices load asynchronously on some browsers (notably Chrome), so cache
// them once and keep the cache fresh via the voiceschanged event.
let cachedVoices = [];
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  const synth = window.speechSynthesis;
  const refreshVoices = () => { cachedVoices = synth.getVoices(); };
  refreshVoices();
  synth.onvoiceschanged = refreshVoices;
}

// Browsers expose many voices of wildly different quality under generic
// names. Score them so we consistently pick the most natural-sounding one
// instead of whatever the platform lists first.
function scoreVoice(v, accentLang) {
  let score = 0;
  const lang = (v.lang || "").toLowerCase();
  if (lang === accentLang.toLowerCase()) score += 10;
  else if (lang.startsWith("en")) score += 4;
  const name = (v.name || "").toLowerCase();
  if (/natural|neural|premium|enhanced|studio/.test(name)) score += 8;
  if (/online/.test(name)) score += 5;
  if (/google/.test(name)) score += 4;
  if (/samantha|daniel|karen|moira|tessa|aaron|nicky|ava|matthew|joanna/.test(name)) score += 3;
  if (/microsoft/.test(name)) score += 2;
  if (/compact|espeak|robot|zira|david/.test(name)) score -= 5;
  if (v.localService === false) score += 1;
  return score;
}

function pickVoice(accentLang) {
  const candidates = cachedVoices.filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => scoreVoice(b, accentLang) - scoreVoice(a, accentLang))[0];
}

function readLegacyProgress() {
  try {
    if (localStorage.getItem(LEGACY_DONE_KEY)) return null;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && data.progress ? data.progress : null;
  } catch (e) {
    return null;
  }
}

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function deckCode(name) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "??";
  const code = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return code.toUpperCase();
}

function authErrorText(err) {
  const code = (err && err.code) || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "E-mail nebo heslo nesedí.";
  if (code.includes("invalid-email")) return "Tohle nevypadá jako platný e-mail.";
  if (code.includes("too-many-requests")) return "Příliš mnoho pokusů. Zkus to za pár minut znovu.";
  if (code.includes("network-request-failed")) return "Nepodařilo se připojit. Zkontroluj internet.";
  if (code.includes("user-disabled")) return "Tento účet je zablokovaný.";
  if (code.includes("email-already-in-use")) return "Tenhle e-mail už je zaregistrovaný. Zkus se rovnou přihlásit.";
  if (code.includes("weak-password")) return "Heslo musí mít aspoň 6 znaků.";
  return "Něco se nepovedlo. Zkus to znovu.";
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text.trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function checkInviteCode(code) {
  const snap = await getDoc(doc(db, "config", "invite"));
  if (!snap.exists() || !snap.data().codeHash) {
    throw new Error("invite-not-configured");
  }
  const hash = await sha256Hex(code);
  return hash === snap.data().codeHash;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function speak(text) {
  try {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const clean = text.replace(/…/g, "").replace(/\(.*?\)/g, "").replace(/\//g, " or ");
    const u = new SpeechSynthesisUtterance(clean);
    const accentLang = speechSettings.accent === "uk" ? "en-GB" : "en-US";
    u.lang = accentLang;
    u.rate = speechSettings.rate;
    const voice = pickVoice(accentLang);
    if (voice) u.voice = voice;
    synth.speak(u);
  } catch (e) {
    /* speech not available */
  }
}

function stopSpeech() {
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}

function sizeClass(text) {
  if (text.length > 34) return "is-long";
  if (text.length > 22) return "is-mid";
  return "";
}

/* ------------------------------------------------------------------ */
/*  BUILT-IN DATA                                                      */
/* ------------------------------------------------------------------ */

const TECH_GROUPS = [
  ["Troubleshooting", [
    ["to troubleshoot a fault", "/ˈtrʌblʃuːt ə fɔːlt/", "hledat a odstranit závadu"],
    ["root cause analysis", "/ruːt kɔːz əˈnæləsɪs/", "analýza kořenové příčiny"],
    ["to narrow down the cause", "/ˈnærəʊ daʊn ðə kɔːz/", "zúžit okruh možných příčin"],
    ["to rule out a possibility", "/ruːl aʊt ə ˌpɒsəˈbɪləti/", "vyloučit možnost"],
    ["an intermittent fault", "/ən ˌɪntəˈmɪtənt fɔːlt/", "občasná, nahodilá závada"],
    ["water hammer", "/ˈwɔːtə ˈhæmə/", "vodní ráz"],
    ["water induction", "/ˈwɔːtər ɪnˈdʌkʃn/", "vniknutí vody do turbíny"],
    ["blade erosion", "/bleɪd ɪˈrəʊʒn/", "eroze lopatek"],
    ["to trip the turbine", "/trɪp ðə ˈtɜːbaɪn/", "odstavit turbínu ochranou"],
    ["a spurious trip", "/ə ˈspjʊəriəs trɪp/", "falešné (nechtěné) odstavení"],
    ["loss of vacuum", "/lɒs əv ˈvækjuːəm/", "ztráta vakua"],
    ["excessive vibration levels", "/ɪkˈsesɪv vaɪˈbreɪʃn ˈlevlz/", "nadměrné vibrace"],
    ["The temperature is drifting up.", "/ˈdrɪftɪŋ ʌp/", "Teplota pozvolna stoupá."],
    ["a faulty transmitter", "/ə ˈfɔːlti trænzˈmɪtə/", "vadný převodník"],
    ["to cross-check the readings", "/ˌkrɒs ˈtʃek ðə ˈriːdɪŋz/", "ověřit naměřené hodnoty"],
    ["a sticking valve spindle", "/ə ˈstɪkɪŋ vælv ˈspɪndl/", "zadírající se vřeteno ventilu"],
    ["leaking gland steam", "/ˈliːkɪŋ ɡlænd stiːm/", "unikající ucpávková pára"],
    ["to isolate the line", "/ˈaɪsəleɪt ðə laɪn/", "uzavřít / odstavit potrubí"],
    ["to drain the condensate", "/dreɪn ðə ˈkɒndənseɪt/", "odvodnit kondenzát"],
    ["a workaround", "/ə ˈwɜːkəraʊnd/", "provizorní, náhradní řešení"],
    ["to restore the unit to service", "/rɪˈstɔː ðə ˈjuːnɪt tə ˈsɜːvɪs/", "vrátit jednotku do provozu"],
    ["thermal shock", "/ˈθɜːml ʃɒk/", "tepelný šok"],
    ["overspeed", "/ˌəʊvəˈspiːd/", "přetočení"],
    ["load rejection", "/ləʊd rɪˈdʒekʃn/", "náhlá ztráta zatížení (shoz zátěže)"],
    ["condition monitoring", "/kənˈdɪʃn ˈmɒnɪtərɪŋ/", "diagnostika stavu"],
  ]],
  ["Turbína", [
    ["turbogenerator", "/ˌtɜːbəʊˈdʒenəreɪtə/", "turbosoustrojí"],
    ["turbine casing", "/ˈtɜːbaɪn ˈkeɪsɪŋ/", "skříň turbíny"],
    ["inner casing", "/ˈɪnə ˈkeɪsɪŋ/", "vnitřní skříň"],
    ["shaft", "/ʃɑːft/", "hřídel"],
    ["moving blade", "/ˈmuːvɪŋ bleɪd/", "oběžná lopatka"],
    ["guide blade", "/ɡaɪd bleɪd/", "rozváděcí lopatka"],
    ["blading", "/ˈbleɪdɪŋ/", "lopatkování"],
    ["diaphragm", "/ˈdaɪəfræm/", "rozváděcí kolo (diafragma)"],
    ["control stage", "/kənˈtrəʊl steɪdʒ/", "regulační stupeň"],
    ["labyrinth seal", "/ˈlæbərɪnθ siːl/", "labyrintové těsnění"],
    ["shaft seal / gland", "/ʃɑːft siːl, ɡlænd/", "ucpávka hřídele"],
    ["balance piston", "/ˈbæləns ˈpɪstən/", "vyrovnávací píst"],
    ["journal bearing", "/ˈdʒɜːnl ˈbeərɪŋ/", "radiální ložisko"],
    ["thrust bearing", "/θrʌst ˈbeərɪŋ/", "axiální ložisko"],
    ["bearing pedestal", "/ˈbeərɪŋ ˈpedɪstl/", "ložiskový stojan"],
    ["coupling", "/ˈkʌplɪŋ/", "spojka"],
    ["clearance", "/ˈklɪərəns/", "vůle"],
    ["condensing turbine", "/kənˈdensɪŋ ˈtɜːbaɪn/", "kondenzační turbína"],
    ["backpressure turbine", "/ˈbækˌpreʃə ˈtɜːbaɪn/", "protitlaká turbína"],
    ["extraction turbine", "/ɪkˈstrækʃn ˈtɜːbaɪn/", "odběrová turbína"],
  ]],
  ["Pára", [
    ["live steam / main steam", "/laɪv stiːm, meɪn stiːm/", "ostrá pára"],
    ["superheated steam", "/ˌsuːpəˈhiːtɪd stiːm/", "přehřátá pára"],
    ["saturated steam", "/ˈsætʃəreɪtɪd stiːm/", "sytá pára"],
    ["wet steam", "/wet stiːm/", "mokrá pára"],
    ["exhaust steam", "/ɪɡˈzɔːst stiːm/", "výstupní pára z turbíny"],
    ["extraction steam", "/ɪkˈstrækʃn stiːm/", "pára z řízeného odběru"],
    ["bleed steam", "/bliːd stiːm/", "pára z neřízeného odběru"],
    ["gland steam", "/ɡlænd stiːm/", "ucpávková pára"],
    ["degree of superheat", "/dɪˈɡriː əv ˈsuːpəhiːt/", "stupeň přehřátí"],
    ["steam admission", "/stiːm ədˈmɪʃn/", "přívod páry"],
    ["desuperheating station", "/ˌdiːsuːpəˈhiːtɪŋ ˈsteɪʃn/", "chladicí stanice páry"],
    ["bypass station", "/ˈbaɪpɑːs ˈsteɪʃn/", "obtoková (redukční) stanice"],
    ["heat balance diagram", "/hiːt ˈbæləns ˈdaɪəɡræm/", "bilanční schéma"],
  ]],
  ["Ventily", [
    ["non-return valve (NRV)", "/ˌnɒn rɪˈtɜːn vælv/", "zpětný ventil"],
    ["emergency stop valve (ESV)", "/ɪˈmɜːdʒənsi stɒp vælv/", "rychlouzavírací ventil"],
    ["main steam isolation valve", "/meɪn stiːm ˌaɪsəˈleɪʃn vælv/", "hlavní parní uzavírací ventil"],
    ["control valve", "/kənˈtrəʊl vælv/", "regulační ventil"],
    ["safety valve", "/ˈseɪfti vælv/", "pojistný ventil"],
    ["rupture disc", "/ˈrʌptʃə dɪsk/", "bezpečnostní membrána"],
    ["solenoid valve", "/ˈsəʊlənɔɪd vælv/", "elektromagnetický ventil"],
    ["pneumatic actuator", "/njuːˈmætɪk ˈæktʃueɪtə/", "pneumatický pohon"],
    ["single-acting actuator", "/ˈsɪŋɡl ˈæktɪŋ ˈæktʃueɪtə/", "jednočinný pohon"],
    ["limit switch", "/ˈlɪmɪt swɪtʃ/", "koncový spínač"],
    ["fail-safe position", "/ˈfeɪl seɪf pəˈzɪʃn/", "bezpečná poloha při ztrátě energie"],
    ["valve seat", "/vælv siːt/", "sedlo ventilu"],
    ["valve stroke", "/vælv strəʊk/", "zdvih ventilu"],
    ["blind flange", "/blaɪnd flændʒ/", "zaslepovací příruba"],
    ["double block and bleed", "/ˈdʌbl blɒk ənd bliːd/", "dokonalé uzavření"],
    ["valve flutter", "/vælv ˈflʌtə/", "kmitání klapky ventilu"],
  ]],
  ["Odvodnění a kondenzátor", [
    ["drainage", "/ˈdreɪnɪdʒ/", "odvodnění"],
    ["condensate", "/ˈkɒndənseɪt/", "kondenzát"],
    ["flash box / flash tank", "/flæʃ bɒks, flæʃ tæŋk/", "expandér / expanzní nádrž"],
    ["drain pot", "/dreɪn pɒt/", "sběrný hrnec kondenzátu"],
    ["steam trap", "/stiːm træp/", "odvaděč kondenzátu"],
    ["orifice", "/ˈɒrɪfɪs/", "clona"],
    ["low point", "/ləʊ pɔɪnt/", "nejnižší bod potrubí"],
    ["slope / gradient", "/sləʊp, ˈɡreɪdiənt/", "spád potrubí"],
    ["condenser", "/kənˈdensə/", "kondenzátor"],
    ["hotwell", "/ˈhɒtwel/", "sběrná nádrž kondenzátu (hotwell)"],
    ["air-cooled condenser (ACC)", "/ˈeə kuːld kənˈdensə/", "vzduchový kondenzátor"],
    ["gland steam condenser (GSC)", "/ɡlænd stiːm kənˈdensə/", "kondenzátor ucpávkové páry"],
    ["steam-jet air ejector", "/ˈstiːm dʒet eər ɪˈdʒektə/", "parní proudová vývěva (ejektor)"],
    ["non-condensable gases", "/ˌnɒn kənˈdensəbl ˈɡæsɪz/", "nekondenzující plyny"],
    ["tube bundle", "/tjuːb ˈbʌndl/", "trubkový svazek"],
    ["condensate pump", "/ˈkɒndənseɪt pʌmp/", "kondenzátní čerpadlo"],
  ]],
  ["Olej, MaR a návrh", [
    ["lube oil system", "/ˈluːb ɔɪl ˈsɪstəm/", "mazací olejový systém"],
    ["jacking oil", "/ˈdʒækɪŋ ɔɪl/", "zdvihací olej"],
    ["oil mist separator", "/ɔɪl mɪst ˈsepəreɪtə/", "separátor olejové mlhy"],
    ["interlock", "/ˈɪntəlɒk/", "blokovací podmínka"],
    ["two-out-of-three voting", "/tuː aʊt əv θriː ˈvəʊtɪŋ/", "logika 2 ze 3"],
    ["differential pressure", "/ˌdɪfəˈrenʃl ˈpreʃə/", "diferenční tlak"],
    ["instrument air", "/ˈɪnstrəmənt eə/", "přístrojový vzduch"],
    ["design pressure", "/dɪˈzaɪn ˈpreʃə/", "výpočtový tlak"],
    ["design temperature", "/dɪˈzaɪn ˈtemprətʃə/", "výpočtová teplota"],
    ["nominal diameter (DN)", "/ˈnɒmɪnl daɪˈæmɪtə/", "jmenovitá světlost"],
    ["Safety Integrity Level (SIL)", "/ˈseɪfti ɪnˈteɡrəti ˈlevl/", "úroveň bezpečnostní integrity"],
    ["piping and instrumentation diagram", "/ˈpaɪpɪŋ ənd ˌɪnstrəmenˈteɪʃn ˈdaɪəɡræm/", "potrubní schéma (P&ID)"],
    ["net positive suction head (NPSH)", "/net ˈpɒzətɪv ˈsʌkʃn hed/", "čistá sací výška čerpadla"],
  ]],
  ["Montáž a údržba", [
    ["commissioning", "/kəˈmɪʃənɪŋ/", "uvádění do provozu"],
    ["erection", "/ɪˈrekʃn/", "strojní montáž"],
    ["alignment", "/əˈlaɪnmənt/", "ustavení"],
    ["overhaul", "/ˈəʊvəhɔːl/", "generální oprava"],
    ["anchor bolt", "/ˈæŋkə bəʊlt/", "kotevní šroub"],
    ["lifting beam", "/ˈlɪftɪŋ biːm/", "zdvihací traverza"],
    ["lay-down area", "/ˈleɪ daʊn ˈeəriə/", "skladovací plocha"],
    ["battery limit", "/ˈbætəri ˈlɪmɪt/", "hranice dodávky"],
    ["scope of supply", "/skəʊp əv səˈplaɪ/", "rozsah dodávky"],
    ["spare parts", "/speə pɑːts/", "náhradní díly"],
    ["lock-out / tag-out (LOTO)", "/ˌlɒk aʊt ˌtæɡ aʊt/", "zajištění proti nechtěnému spuštění"],
    ["depressurisation", "/diːˌpreʃəraɪˈzeɪʃn/", "odtlakování"],
    ["acceptance testing", "/əkˈseptəns ˈtestɪŋ/", "přejímací zkoušky"],
  ]],
  ["Ložiska a mazání", [
    ["bearing clearance", "/ˈbeərɪŋ ˈklɪərəns/", "vůle v ložisku"],
    ["oil film", "/ɔɪl fɪlm/", "olejový film"],
    ["babbitt metal", "/ˈbæbɪt ˈmetl/", "ložiskový kov (babbit)"],
    ["oil whirl", "/ɔɪl wɜːl/", "olejový vír (nestabilita ložiska)"],
    ["lube oil pressure", "/luːb ɔɪl ˈpreʃə/", "tlak mazacího oleje"],
    ["bearing temperature", "/ˈbeərɪŋ ˈtemprətʃə/", "teplota ložiska"],
    ["radial clearance", "/ˈreɪdiəl ˈklɪərəns/", "radiální vůle"],
    ["axial clearance", "/ˈæksiəl ˈklɪərəns/", "axiální vůle"],
    ["oil viscosity grade", "/vɪˈskɒsəti ɡreɪd/", "třída viskozity oleje"],
    ["bearing wear", "/ˈbeərɪŋ weə/", "opotřebení ložiska"],
    ["thrust collar", "/θrʌst ˈkɒlə/", "axiální kroužek, límec"],
    ["bearing housing", "/ˈbeərɪŋ ˈhaʊzɪŋ/", "těleso ložiska"],
    ["lube oil filter", "/luːb ɔɪl ˈfɪltə/", "filtr mazacího oleje"],
    ["oil degradation", "/ɔɪl ˌdeɡrəˈdeɪʃn/", "degradace oleje"],
  ]],
  ["Regulace a řízení (I&C)", [
    ["control loop", "/kənˈtrəʊl luːp/", "regulační smyčka"],
    ["setpoint", "/ˈsetpɔɪnt/", "žádaná hodnota"],
    ["feedback signal", "/ˈfiːdbæk ˈsɪɡnəl/", "zpětnovazební signál"],
    ["PID controller", "/piː aɪ diː kənˈtrəʊlə/", "PID regulátor"],
    ["actuator response time", "/ˈæktʃueɪtə rɪˈspɒns/", "doba odezvy pohonu"],
    ["analog signal", "/ˈænəlɒɡ ˈsɪɡnəl/", "analogový signál"],
    ["digital input", "/ˈdɪdʒɪtl ˈɪnpʊt/", "digitální vstup"],
    ["control cabinet", "/kənˈtrəʊl ˈkæbɪnɪt/", "rozváděč řídicího systému"],
    ["redundant sensor", "/rɪˈdʌndənt ˈsensə/", "záložní čidlo"],
    ["signal drift", "/ˈsɪɡnəl drɪft/", "posun (drift) signálu"],
    ["override function", "/ˈəʊvəraɪd ˈfʌŋkʃn/", "funkce ručního přepsání"],
    ["alarm threshold", "/əˈlɑːm ˈθreʃhəʊld/", "prahová hodnota alarmu"],
    ["man-machine interface", "/mæn məˈʃiːn ˈɪntəfeɪs/", "rozhraní obsluha-stroj"],
    ["fail-to-safe logic", "/feɪl tə seɪf ˈlɒdʒɪk/", "bezpečnostní logika při poruše"],
  ]],
  ["Generátor a elektrická část", [
    ["generator stator", "/ˈdʒenəreɪtə ˈsteɪtə/", "stator generátoru"],
    ["generator rotor", "/ˈdʒenəreɪtə ˈrəʊtə/", "rotor generátoru"],
    ["excitation system", "/ˌeksɪˈteɪʃn ˈsɪstəm/", "budicí systém"],
    ["stator winding", "/ˈsteɪtə ˈwaɪndɪŋ/", "vinutí statoru"],
    ["air gap", "/eə ɡæp/", "vzduchová mezera"],
    ["synchronisation", "/ˌsɪŋkrənaɪˈzeɪʃn/", "synchronizace (se sítí)"],
    ["power factor", "/ˈpaʊə ˈfæktə/", "účiník"],
    ["generator terminal", "/ˈdʒenəreɪtə ˈtɜːmɪnl/", "svorka generátoru"],
    ["stray flux", "/streɪ flʌks/", "rozptylový tok"],
    ["insulation resistance", "/ˌɪnsjʊˈleɪʃn rɪˈzɪstəns/", "izolační odpor"],
    ["busbar", "/ˈbʌsbɑː/", "sběrnice"],
    ["transformer", "/trænsˈfɔːmə/", "transformátor"],
    ["cooling gas (hydrogen)", "/ˈkuːlɪŋ ɡæs/", "chladicí plyn (vodík)"],
  ]],
  ["Bezpečnostní systémy", [
    ["trip logic", "/trɪp ˈlɒdʒɪk/", "odstavovací logika"],
    ["redundant trip channel", "/rɪˈdʌndənt trɪp ˈtʃænl/", "záložní odstavovací kanál"],
    ["safety instrumented system", "/ˈseɪfti ˈɪnstrəmentɪd/", "bezpečnostní přístrojový systém"],
    ["common cause failure", "/ˈkɒmən kɔːz ˈfeɪljə/", "porucha se společnou příčinou"],
    ["proof test", "/pruːf test/", "ověřovací zkouška"],
    ["fail-safe design", "/feɪl seɪf dɪˈzaɪn/", "bezpečný návrh při poruše"],
    ["trip and throttle valve", "/trɪp ənd ˈθrɒtl vælv/", "kombinovaný rychlouzavírací a regulační ventil"],
    ["emergency governor", "/ɪˈmɜːdʒənsi ˈɡʌvənə/", "nouzový regulátor otáček"],
    ["overspeed test", "/ˌəʊvəˈspiːd test/", "zkouška na přetočení"],
    ["hazard and operability study", "/ˈhæzəd/", "studie nebezpečí a provozuschopnosti (HAZOP)"],
  ]],
  ["Diagnostika a vibrace", [
    ["vibration probe", "/vaɪˈbreɪʃn prəʊb/", "vibrační sonda"],
    ["shaft orbit", "/ʃɑːft ˈɔːbɪt/", "orbita hřídele"],
    ["spectral analysis", "/ˈspektrəl əˈnæləsɪs/", "spektrální analýza"],
    ["phase angle", "/feɪz ˈæŋɡl/", "fázový úhel"],
    ["unbalance", "/ʌnˈbæləns/", "nevyváženost"],
    ["misalignment", "/ˌmɪsəˈlaɪnmənt/", "nesouosost"],
    ["critical speed", "/ˈkrɪtɪkl spiːd/", "kritické otáčky"],
    ["run-out", "/rʌn aʊt/", "házivost"],
    ["baseline reading", "/ˈbeɪslaɪn ˈriːdɪŋ/", "výchozí naměřená hodnota"],
    ["trend monitoring", "/trend ˈmɒnɪtərɪŋ/", "sledování trendu"],
    ["proximity probe", "/prɒkˈsɪməti prəʊb/", "bezdotyková sonda"],
    ["keyphasor", "/kiːˈfeɪzə/", "referenční otáčkové čidlo"],
  ]],
  ["Svařování a materiály", [
    ["weld inspection", "/weld ɪnˈspekʃn/", "kontrola svaru"],
    ["heat-affected zone", "/hiːt əˈfektɪd zəʊn/", "tepelně ovlivněná oblast"],
    ["post-weld heat treatment", "/pəʊst weld/", "tepelné zpracování po svařování"],
    ["weld procedure specification", "/weld prəˈsiːdʒə/", "specifikace postupu svařování"],
    ["filler material", "/ˈfɪlə məˈtɪəriəl/", "přídavný materiál"],
    ["preheat temperature", "/ˈpriːhiːt ˈtemprətʃə/", "teplota předehřevu"],
    ["weld defect", "/weld ˈdiːfekt/", "vada svaru"],
    ["radiographic testing", "/ˌreɪdiəˈɡræfɪk/", "rentgenová zkouška"],
    ["ultrasonic testing", "/ˌʌltrəˈsɒnɪk/", "ultrazvuková zkouška"],
    ["dye penetrant test", "/daɪ ˈpenɪtrənt/", "kapilární zkouška"],
    ["magnetic particle test", "/mæɡˈnetɪk ˈpɑːtɪkl/", "zkouška magnetickou práškovou metodou"],
    ["material certificate", "/məˈtɪəriəl səˈtɪfɪkət/", "materiálový atest"],
  ]],
  ["Dokumentace a standardy", [
    ["as-found condition", "/æz faʊnd kənˈdɪʃn/", "stav při nálezu"],
    ["as-left condition", "/æz left kənˈdɪʃn/", "stav po dokončení"],
    ["inspection report", "/ɪnˈspekʃn rɪˈpɔːt/", "protokol o prohlídce"],
    ["outage scope", "/ˈaʊtɪdʒ skəʊp/", "rozsah odstávky"],
    ["work permit", "/wɜːk ˈpɜːmɪt/", "pracovní povolení"],
    ["technical specification", "/ˈteknɪkl ˌspesɪfɪˈkeɪʃn/", "technická specifikace"],
    ["deviation report", "/ˌdiːviˈeɪʃn rɪˈpɔːt/", "hlášení odchylky"],
    ["field modification", "/fiːld ˌmɒdɪfɪˈkeɪʃn/", "úprava provedená na místě"],
    ["service bulletin", "/ˈsɜːvɪs ˈbʊlɪtɪn/", "servisní bulletin"],
    ["root cause report", "/ruːt kɔːz rɪˈpɔːt/", "zpráva o kořenové příčině"],
    ["non-conformance report", "/nɒn kənˈfɔːməns/", "zpráva o neshodě"],
  ]],
  ["Troubleshooting pokročilé", [
    ["to isolate a fault", "/ˈaɪsəleɪt fɔːlt/", "lokalizovat závadu"],
    ["to bypass a signal temporarily", "/ˈbaɪpɑːs/", "dočasně obejít signál"],
    ["to simulate a trip", "/ˈsɪmjuleɪt trɪp/", "simulovat odstavení"],
    ["to reproduce a fault", "/ˌriːprəˈdjuːs/", "reprodukovat závadu"],
    ["to escalate an issue", "/ˈeskəleɪt/", "eskalovat problém"],
    ["to log an event", "/lɒɡ ən ɪˈvent/", "zaznamenat událost"],
    ["event sequence recorder", "/ɪˈvent ˈsiːkwəns/", "záznamník sledu událostí"],
    ["to pinpoint the cause", "/ˈpɪnpɔɪnt/", "přesně určit příčinu"],
    ["interim fix", "/ˈɪntərɪm fɪks/", "provizorní oprava"],
    ["to verify a repair", "/ˈverɪfaɪ/", "ověřit opravu"],
    ["recurring fault", "/rɪˈkɜːrɪŋ fɔːlt/", "opakující se závada"],
    ["corrective action plan", "/kəˈrektɪv ˈækʃn/", "plán nápravných opatření"],
    ["permanent fix", "/ˈpɜːmənənt fɪks/", "trvalé řešení, oprava"],
    ["troubleshooting checklist", "/ˈtrʌblʃuːtɪŋ ˈtʃeklɪst/", "kontrolní seznam pro diagnostiku"],
  ]],
];

const CUSTOMER_GROUPS = [
  ["Vyjednávání", [
    ["to reach an agreement", "/riːtʃ ən əˈɡriːmənt/", "dosáhnout dohody"],
    ["to find common ground", "/ˈkɒmən ɡraʊnd/", "najít společnou řeč"],
    ["to meet halfway", "/miːt ˌhɑːfˈweɪ/", "vyjít si vstříc na půl cesty"],
    ["a deal-breaker", "/ə ˈdiːlbreɪkə/", "podmínka, na které dohoda padne"],
    ["That is non-negotiable.", "/nɒn nɪˈɡəʊʃiəbl/", "To je nediskutovatelné."],
    ["That's not something we can commit to.", "/kəˈmɪt tuː/", "K tomu se nemůžeme zavázat."],
    ["Let me come back to you on that.", "/kʌm bæk tuː juː/", "K tomu se vám ozvu později."],
    ["That's outside my authority.", "/ɔːˈθɒrəti/", "To je nad rámec mých pravomocí."],
    ["I'd have to check with my manager.", "/tʃek wɪð/", "Musel bych to ověřit s nadřízeným."],
    ["to push back on a request", "/pʊʃ bæk/", "oponovat požadavku, odmítnout ho"],
    ["Where's the main sticking point?", "/ˈstɪkɪŋ pɔɪnt/", "V čem je hlavní zádrhel?"],
    ["Would you be open to …?", "/ˈəʊpən tuː/", "Byli byste otevřeni…?"],
    ["If we do X, could you do Y?", "/kʊd juː/", "Když uděláme X, mohli byste Y?"],
    ["I hear you, but …", "/aɪ hɪə juː/", "Rozumím vám, ale…"],
    ["With all due respect, …", "/wɪð ɔːl djuː rɪˈspekt/", "Se vší úctou,…"],
    ["Let's park that for now.", "/pɑːk ðæt/", "Odložme to zatím stranou."],
    ["to bring it up at the next meeting", "/brɪŋ ɪt ʌp/", "otevřít to na příští schůzce"],
    ["a goodwill gesture", "/ə ˈɡʊdwɪl ˈdʒestʃə/", "gesto dobré vůle"],
    ["It's still under warranty.", "/ˈwɒrənti/", "Je to ještě v záruce."],
    ["liquidated damages", "/ˈlɪkwɪdeɪtɪd ˈdæmɪdʒɪz/", "smluvní pokuta"],
    ["to renegotiate the deadline", "/ˌriːnɪˈɡəʊʃieɪt/", "znovu vyjednat termín"],
    ["That would set a precedent.", "/ˈpresɪdənt/", "To by vytvořilo precedens."],
    ["on the understanding that …", "/ˌʌndəˈstændɪŋ/", "za předpokladu, že…"],
    ["Let's put that in writing.", "/ɪn ˈraɪtɪŋ/", "Dejme to písemně."],
  ]],
  ["Reporting", [
    ["Let me walk you through it.", "/wɔːk juː θruː/", "Provedu vás tím krok za krokem."],
    ["Based on the trend data, …", "/beɪst ɒn ðə trend ˈdeɪtə/", "Na základě trendových dat…"],
    ["The evidence points to …", "/ˈevɪdəns pɔɪnts tuː/", "Vše nasvědčuje tomu, že…"],
    ["We can't rule that out yet.", "/ruːl ðæt aʊt/", "Zatím to nemůžeme vyloučit."],
    ["I'd rather not speculate.", "/ˈspekjuleɪt/", "Nerad bych spekuloval."],
    ["My best guess at this stage is …", "/best ɡes/", "Můj současný odhad je…"],
    ["to keep you in the loop", "/ɪn ðə luːp/", "průběžně vás informovat"],
    ["to give you a quick update", "/kwɪk ˈʌpdeɪt/", "stručně vás informovat"],
    ["as a precautionary measure", "/prɪˈkɔːʃənəri ˈmeʒə/", "jako preventivní opatření"],
    ["It's a temporary fix.", "/ˈtemprəri fɪks/", "Je to dočasné řešení."],
    ["We'll have to take the unit offline.", "/ˌɒfˈlaɪn/", "Budeme muset jednotku odstavit."],
    ["This is within our scope of supply.", "/skəʊp əv səˈplaɪ/", "To spadá do našeho rozsahu dodávky."],
    ["That falls outside our scope.", "/fɔːlz aʊtˈsaɪd/", "To je mimo náš rozsah."],
    ["to raise a concern", "/reɪz ə kənˈsɜːn/", "upozornit na obavu"],
    ["I'd like to flag a potential risk.", "/flæɡ ə pəˈtenʃl rɪsk/", "Chci upozornit na možné riziko."],
    ["to sign off on the report", "/saɪn ɒf/", "odsouhlasit / schválit zprávu"],
    ["lessons learned", "/ˈlesnz lɜːnd/", "poučení z realizace"],
    ["to follow up on something", "/ˈfɒləʊ ʌp/", "navázat na něco, dořešit"],
    ["Correct me if I'm wrong, but …", "/kəˈrekt miː/", "Opravte mě, pokud se mýlím, ale…"],
    ["Let me make sure I've got this right.", "/meɪk ʃɔː/", "Ujistím se, že to chápu správně."],
    ["Could you talk me through the alarms?", "/tɔːk miː θruː/", "Můžete mi projít ty alarmy?"],
    ["to put it in plain terms", "/pleɪn tɜːmz/", "jednoduše řečeno"],
    ["unplanned downtime", "/ʌnˈplænd ˈdaʊntaɪm/", "neplánovaný prostoj"],
    ["plant availability", "/plɑːnt əˌveɪləˈbɪləti/", "disponibilita zařízení"],
  ]],
  ["Meeting", [
    ["I'll drop it in the chat.", "/drɒp ɪt ɪn ðə tʃæt/", "Hodím to do chatu."],
    ["Sorry, you cut out for a second.", "/kʌt aʊt/", "Promiňte, na chvíli vám vypadlo spojení."],
    ["Could I just jump in here?", "/dʒʌmp ɪn/", "Můžu se sem na moment vložit?"],
    ["Let's take this offline.", "/teɪk ðɪs ˌɒfˈlaɪn/", "Proberme to mimo tuhle schůzku."],
    ["Can everyone see my screen?", "/skriːn/", "Vidíte všichni moji obrazovku?"],
    ["Just to recap, …", "/ˈriːkæp/", "Jen pro shrnutí…"],
    ["What are the next steps?", "/nekst steps/", "Jaké jsou další kroky?"],
    ["to set up a follow-up meeting", "/ˈfɒləʊ ʌp ˈmiːtɪŋ/", "domluvit navazující schůzku"],
    ["I'll send over the minutes.", "/ˈmɪnɪts/", "Pošlu vám zápis z jednání."],
    ["Let's wrap up the call.", "/ræp ʌp/", "Pojďme hovor uzavřít."],
  ]],
  ["E-mailová komunikace", [
    ["I am writing to inform you that...", "/ˈraɪtɪŋ tə ɪnˈfɔːm/", "Píšu vám, abych vás informoval, že..."],
    ["Please find attached...", "/əˈtætʃt/", "V příloze naleznete..."],
    ["I would like to follow up on...", "/ˈfɒləʊ ʌp/", "Rád bych navázal na..."],
    ["Thank you for your prompt reply.", "/prɒmpt rɪˈplaɪ/", "Děkuji za vaši rychlou odpověď."],
    ["I look forward to hearing from you.", "/lʊk ˈfɔːwəd/", "Těším se na vaši odpověď."],
    ["Please do not hesitate to contact me.", "/ˈhezɪteɪt/", "Neváhejte mě kontaktovat."],
    ["Apologies for the delayed response.", "/əˈpɒlədʒiz/", "Omlouvám se za opožděnou odpověď."],
    ["Could you please clarify...?", "/ˈklærɪfaɪ/", "Mohli byste prosím upřesnit...?"],
    ["I am forwarding this email to...", "/ˈfɔːwədɪŋ/", "Přeposílám tento e-mail..."],
    ["cc'd on this email", "/siː siːd/", "v kopii tohoto e-mailu"],
    ["to loop someone in", "/luːp ɪn/", "přizvat někoho do konverzace"],
    ["as per our conversation", "/əz pɜː/", "jak jsme se domluvili"],
    ["kind regards", "/riˈɡɑːdz/", "s pozdravem"],
  ]],
  ["Prezentace a školení zákazníka", [
    ["Let me give you a brief overview.", "/ˈbriːf ˈəʊvəvjuː/", "Dovolte mi stručný přehled."],
    ["Moving on to the next slide...", "/muːvɪŋ ɒn/", "Přejdu na další slide..."],
    ["To summarise the key points...", "/ˈsʌməraɪz/", "Shrneme-li klíčové body..."],
    ["Are there any questions so far?", "/kwestʃənz/", "Máte zatím nějaké dotazy?"],
    ["I'll hand over to my colleague.", "/hænd ˈəʊvə/", "Předám slovo kolegovi."],
    ["Let's dive into the details.", "/daɪv ˈɪntuː/", "Pojďme se ponořit do detailů."],
    ["This chart illustrates...", "/ˈɪləstreɪts/", "Tento graf znázorňuje..."],
    ["As you can see on the screen...", "/skriːn/", "Jak vidíte na obrazovce..."],
    ["To put it simply...", "/ˈsɪmpli/", "Jednoduše řečeno..."],
    ["I'll come back to that point later.", "/kʌm bæk/", "K tomu se ještě vrátím."],
    ["hands-on training", "/hændz ɒn ˈtreɪnɪŋ/", "praktické školení"],
    ["training material", "/ˈtreɪnɪŋ məˈtɪəriəl/", "školicí materiály"],
  ]],
  ["Cenové jednání a nabídky", [
    ["to submit a quote", "/səbˈmɪt ə kwəʊt/", "předložit cenovou nabídku"],
    ["to be within budget", "/ˈbʌdʒɪt/", "vejít se do rozpočtu"],
    ["payment terms", "/ˈpeɪmənt tɜːmz/", "platební podmínky"],
    ["to offer a discount", "/ˈdɪskaʊnt/", "nabídnout slevu"],
    ["lead time on delivery", "/liːd taɪm/", "dodací lhůta"],
    ["to revise a quote", "/rɪˈvaɪz/", "upravit nabídku"],
    ["binding offer", "/ˈbaɪndɪŋ ˈɒfə/", "závazná nabídka"],
    ["to be cost-competitive", "/kɒst kəmˈpetətɪv/", "být cenově konkurenceschopný"],
    ["to include in the scope", "/skəʊp/", "zahrnout do rozsahu"],
    ["additional cost", "/əˈdɪʃənl kɒst/", "dodatečné náklady"],
    ["penalty clause", "/ˈpenəlti klɔːz/", "smluvní pokuta, sankční doložka"],
    ["to finalise the contract", "/ˈfaɪnəlaɪz/", "dokončit smlouvu"],
  ]],
  ["Řešení stížností", [
    ["I understand your frustration.", "/frʌˈstreɪʃn/", "Chápu vaši frustraci."],
    ["Let me look into this for you.", "/lʊk ˈɪntuː/", "Nechte mě to prošetřit."],
    ["We take this matter seriously.", "/ˈsɪəriəsli/", "Bereme tuto záležitost vážně."],
    ["I'll get back to you with an update.", "/ˈʌpdeɪt/", "Ozvu se vám s aktuálním stavem."],
    ["We apologise for the inconvenience.", "/ɪnkənˈviːniəns/", "Omlouváme se za způsobené potíže."],
    ["to escalate a complaint", "/ˈeskəleɪt/", "eskalovat stížnost"],
    ["root cause of the complaint", "/ruːt kɔːz/", "kořenová příčina stížnosti"],
    ["compensation", "/ˌkɒmpenˈseɪʃn/", "odškodnění"],
    ["to make things right", "/raɪt/", "napravit situaci"],
    ["service recovery", "/ˈsɜːvɪs rɪˈkʌvəri/", "náprava po pochybení v servisu"],
    ["to prevent a recurrence", "/rɪˈkʌrəns/", "zabránit opakování"],
    ["to close the loop with the customer", "/kləʊz ðə luːp/", "uzavřít celou záležitost se zákazníkem"],
    ["customer satisfaction", "/kəsˈtəmə ˌsætɪsˈfækʃn/", "spokojenost zákazníka"],
  ]],
];

const GENERAL_B2_GROUPS = [
  ["Denní rutina", [
    ["to wake up", "/weɪk ʌp/", "probudit se"],
    ["to get dressed", "/ɡet drest/", "obléknout se"],
    ["to commute", "/kəˈmjuːt/", "dojíždět do práce"],
    ["to run errands", "/rʌn ˈerəndz/", "vyřizovat pochůzky"],
    ["to do the chores", "/duː ðə tʃɔːz/", "dělat domácí práce"],
    ["to unwind", "/ʌnˈwaɪnd/", "odreagovat se"],
    ["to doze off", "/dəʊz ɒf/", "usnout, zdřímnout"],
    ["to oversleep", "/ˌəʊvəˈsliːp/", "zaspat"],
    ["routine", "/ruːˈtiːn/", "zaběhlý postup, rutina"],
    ["habit", "/ˈhæbɪt/", "zvyk"],
    ["to be exhausted", "/ɪɡˈzɔːstɪd/", "být vyčerpaný"],
    ["to catch up on sleep", "/kætʃ ʌp ɒn sliːp/", "dohnat spánek"],
    ["to be in a rush", "/rʌʃ/", "spěchat"],
    ["to procrastinate", "/prəˈkræstɪneɪt/", "odkládat věci na později"],
    ["to multitask", "/ˈmʌltitɑːsk/", "dělat víc věcí najednou"],
    ["to plan ahead", "/plæn əˈhed/", "plánovat dopředu"],
    ["leisure time", "/ˈleʒər taɪm/", "volný čas"],
    ["to relax", "/rɪˈlæks/", "odpočívat"],
    ["to be worn out", "/wɔːn aʊt/", "být utahaný"],
    ["to stick to a schedule", "/stɪk tuː ə ˈʃedjuːl/", "držet se harmonogramu"],
    ["to skip breakfast", "/skɪp ˈbrekfəst/", "vynechat snídani"],
    ["to grab a bite", "/ɡræb ə baɪt/", "rychle se zakousnout"],
    ["to head off", "/hed ɒf/", "vyrazit, odejít"],
    ["to settle down", "/ˈsetl daʊn/", "usadit se"],
    ["bedtime", "/ˈbedtaɪm/", "doba spánku"],
  ]],
  ["Osobnost a charakter", [
    ["outgoing", "/ˌaʊtˈɡəʊɪŋ/", "společenský, otevřený"],
    ["reserved", "/rɪˈzɜːvd/", "uzavřený, zdrženlivý"],
    ["stubborn", "/ˈstʌbən/", "tvrdohlavý"],
    ["reliable", "/rɪˈlaɪəbl/", "spolehlivý"],
    ["easy-going", "/ˌiːzi ˈɡəʊɪŋ/", "pohodový"],
    ["ambitious", "/æmˈbɪʃəs/", "ambiciózní"],
    ["generous", "/ˈdʒenərəs/", "štědrý"],
    ["selfish", "/ˈselfɪʃ/", "sobecký"],
    ["modest", "/ˈmɒdɪst/", "skromný"],
    ["arrogant", "/ˈærəɡənt/", "arogantní"],
    ["sensitive", "/ˈsensətɪv/", "citlivý"],
    ["confident", "/ˈkɒnfɪdənt/", "sebejistý"],
    ["shy", "/ʃaɪ/", "stydlivý"],
    ["curious", "/ˈkjʊəriəs/", "zvědavý"],
    ["patient", "/ˈpeɪʃnt/", "trpělivý"],
    ["impatient", "/ɪmˈpeɪʃnt/", "netrpělivý"],
    ["honest", "/ˈɒnɪst/", "upřímný"],
    ["cautious", "/ˈkɔːʃəs/", "opatrný"],
    ["optimistic", "/ˌɒptɪˈmɪstɪk/", "optimistický"],
    ["pessimistic", "/ˌpesɪˈmɪstɪk/", "pesimistický"],
    ["determined", "/dɪˈtɜːmɪnd/", "odhodlaný"],
    ["laid-back", "/ˌleɪd ˈbæk/", "v klidu, nenapjatý"],
    ["hard-working", "/ˌhɑːd ˈwɜːkɪŋ/", "pracovitý"],
    ["moody", "/ˈmuːdi/", "náladový"],
    ["trustworthy", "/ˈtrʌstwɜːði/", "důvěryhodný"],
  ]],
  ["Pocity a emoce", [
    ["to feel overwhelmed", "/əʊvəˈwelmd/", "cítit se zahlcený"],
    ["to feel relieved", "/rɪˈliːvd/", "cítit se s úlevou"],
    ["to feel anxious", "/ˈæŋkʃəs/", "cítit úzkost"],
    ["to feel embarrassed", "/ɪmˈbærəst/", "stydět se, být trapně"],
    ["to feel frustrated", "/frʌˈstreɪtɪd/", "cítit se frustrovaný"],
    ["to feel jealous", "/ˈdʒeləs/", "žárlit"],
    ["to feel grateful", "/ˈɡreɪtfl/", "cítit vděčnost"],
    ["to feel homesick", "/ˈhəʊmsɪk/", "stýskat se po domově"],
    ["to feel proud", "/praʊd/", "být pyšný"],
    ["to feel guilty", "/ˈɡɪlti/", "cítit se provinile"],
    ["to burst into tears", "/bɜːst ˈɪntuː tɪəz/", "propuknout v pláč"],
    ["to lose one's temper", "/luːz wʌnz ˈtempə/", "ztratit nervy"],
    ["to calm down", "/kɑːm daʊn/", "uklidnit se"],
    ["to cheer up", "/tʃɪər ʌp/", "rozveselit se"],
    ["to be fed up", "/fed ʌp/", "mít toho dost"],
    ["to be delighted", "/dɪˈlaɪtɪd/", "být nadšený, potěšený"],
    ["to be furious", "/ˈfjʊəriəs/", "být zuřivý"],
    ["to be terrified", "/ˈterɪfaɪd/", "být vyděšený"],
    ["mixed feelings", "/mɪkst ˈfiːlɪŋz/", "smíšené pocity"],
    ["to hold a grudge", "/həʊld ə ɡrʌdʒ/", "chovat zášť"],
    ["to feel down", "/daʊn/", "cítit se skleslý"],
    ["to be moved", "/muːvd/", "být dojatý"],
    ["to feel reassured", "/ˌriːəˈʃʊəd/", "cítit se ujištěný, uklidněný"],
    ["to snap at someone", "/snæp/", "utrhnout se na někoho"],
    ["to bottle up feelings", "/ˈbɒtl ʌp/", "potlačovat city v sobě"],
  ]],
  ["Práce a kariéra", [
    ["to apply for a job", "/əˈplaɪ/", "ucházet se o práci"],
    ["job interview", "/dʒɒb ˈɪntəvjuː/", "pracovní pohovor"],
    ["to get promoted", "/prəˈməʊtɪd/", "být povýšen"],
    ["to hand in one's notice", "/hænd ɪn/", "podat výpověď"],
    ["to be laid off", "/leɪd ɒf/", "být propuštěn (nadbytečnost)"],
    ["colleague", "/ˈkɒliːɡ/", "kolega"],
    ["deadline", "/ˈdedlaɪn/", "termín, uzávěrka"],
    ["workload", "/ˈwɜːkləʊd/", "pracovní vytížení"],
    ["to be in charge of", "/tʃɑːdʒ/", "mít na starosti"],
    ["salary", "/ˈsæləri/", "plat"],
    ["to earn a living", "/ɜːn ə ˈlɪvɪŋ/", "vydělávat si na živobytí"],
    ["to be self-employed", "/self ɪmˈplɔɪd/", "být osoba samostatně výdělečně činná"],
    ["to work overtime", "/ˈəʊvətaɪm/", "pracovat přesčas"],
    ["to meet a deadline", "/miːt/", "stihnout termín"],
    ["qualification", "/ˌkwɒlɪfɪˈkeɪʃn/", "kvalifikace"],
    ["to negotiate a salary", "/nɪˈɡəʊʃieɪt/", "vyjednávat o platu"],
    ["employee benefits", "/ɪmˈplɔɪiː ˈbenɪfɪts/", "zaměstnanecké výhody"],
    ["to resign", "/rɪˈzaɪn/", "rezignovat"],
    ["to be understaffed", "/ˌʌndəˈstɑːft/", "mít nedostatek personálu"],
    ["career path", "/kəˈrɪə pɑːθ/", "kariérní dráha"],
    ["to burn out", "/bɜːn aʊt/", "vyhořet (psychicky)"],
    ["to network", "/ˈnetwɜːk/", "budovat pracovní kontakty"],
    ["probation period", "/prəˈbeɪʃn ˈpɪəriəd/", "zkušební doba"],
    ["to be on sick leave", "/sɪk liːv/", "být na nemocenské"],
    ["performance review", "/pəˈfɔːməns rɪˈvjuː/", "hodnocení výkonu"],
  ]],
  ["Vzdělávání", [
    ["to enroll in a course", "/ɪnˈrəʊl/", "zapsat se do kurzu"],
    ["to fail an exam", "/feɪl/", "propadnout u zkoušky"],
    ["to pass with flying colours", "/ˈflaɪɪŋ ˈkʌləz/", "udělat zkoušku s vyznamenáním"],
    ["to cram for an exam", "/kræm/", "biflovat se na zkoušku"],
    ["assignment", "/əˈsaɪnmənt/", "úkol, zadání"],
    ["tuition fees", "/tjuˈɪʃn fiːz/", "školné"],
    ["scholarship", "/ˈskɒləʃɪp/", "stipendium"],
    ["to drop out", "/drɒp aʊt/", "odejít ze školy předčasně"],
    ["lecture", "/ˈlektʃə/", "přednáška"],
    ["to take notes", "/nəʊts/", "dělat si poznámky"],
    ["curriculum", "/kəˈrɪkjələm/", "učební osnovy"],
    ["to revise", "/rɪˈvaɪz/", "opakovat si látku"],
    ["to hand in an assignment", "/hænd ɪn/", "odevzdat úkol"],
    ["plagiarism", "/ˈpleɪdʒərɪzəm/", "plagiátorství"],
    ["to graduate", "/ˈɡrædʒueɪt/", "vystudovat, promovat"],
    ["degree", "/dɪˈɡriː/", "vysokoškolský titul"],
    ["to major in something", "/ˈmeɪdʒə/", "studovat jako hlavní obor"],
    ["mentor", "/ˈmentɔː/", "mentor"],
    ["to fall behind", "/fɔːl bɪˈhaɪnd/", "zaostávat"],
    ["to keep up with", "/kiːp ʌp/", "držet krok s"],
    ["distance learning", "/ˈdɪstəns ˈlɜːnɪŋ/", "distanční studium"],
    ["to sit an exam", "/sɪt/", "psát zkoušku"],
    ["marking scheme", "/ˈmɑːkɪŋ skiːm/", "hodnoticí systém"],
    ["literacy", "/ˈlɪtərəsi/", "gramotnost"],
    ["to broaden one's horizons", "/ˈbrɔːdn/", "rozšířit si obzory"],
  ]],
  ["Zdraví a tělo", [
    ["to catch a cold", "/kætʃ/", "nachladit se"],
    ["to feel under the weather", "/ˈʌndə ðə ˈweðə/", "necítit se dobře"],
    ["to recover", "/rɪˈkʌvə/", "zotavit se"],
    ["symptom", "/ˈsɪmptəm/", "příznak"],
    ["to prescribe medicine", "/prɪˈskraɪb/", "předepsat léky"],
    ["to book an appointment", "/əˈpɔɪntmənt/", "objednat se na termín"],
    ["to have a check-up", "/tʃek ʌp/", "jít na preventivní prohlídku"],
    ["allergy", "/ˈælədʒi/", "alergie"],
    ["to sprain an ankle", "/spreɪn/", "vymknout si kotník"],
    ["painkiller", "/ˈpeɪnkɪlə/", "lék proti bolesti"],
    ["to be on a diet", "/ˈdaɪət/", "držet dietu"],
    ["balanced diet", "/ˈbælənst ˈdaɪət/", "vyvážená strava"],
    ["stress-related", "/stres rɪˈleɪtɪd/", "související se stresem"],
    ["to stay fit", "/steɪ fɪt/", "udržovat se v kondici"],
    ["immune system", "/ɪˈmjuːn ˈsɪstəm/", "imunitní systém"],
    ["to get vaccinated", "/ˈvæksɪneɪtɪd/", "nechat se očkovat"],
    ["wellbeing", "/ˈwelbiːɪŋ/", "duševní pohoda"],
    ["to work out", "/wɜːk aʊt/", "cvičit"],
    ["to sprain a muscle", "/spreɪn/", "natáhnout si sval"],
    ["chronic pain", "/ˈkrɒnɪk peɪn/", "chronická bolest"],
    ["nutritious", "/njuˈtrɪʃəs/", "výživný"],
    ["to be dehydrated", "/diːˈhaɪdreɪtɪd/", "být dehydrovaný"],
    ["posture", "/ˈpɒstʃə/", "držení těla"],
  ]],
  ["Cestování a doprava", [
    ["to book a flight", "/bʊk/", "zarezervovat let"],
    ["connecting flight", "/kəˈnektɪŋ flaɪt/", "navazující let"],
    ["boarding pass", "/ˈbɔːdɪŋ pɑːs/", "palubní vstupenka"],
    ["delayed", "/dɪˈleɪd/", "zpožděný"],
    ["to check in", "/tʃek ɪn/", "odbavit se"],
    ["luggage allowance", "/ˈlʌɡɪdʒ əˈlaʊəns/", "povolený limit zavazadel"],
    ["itinerary", "/aɪˈtɪnərəri/", "plán cesty"],
    ["to go sightseeing", "/ˈsaɪtsiːɪŋ/", "jít si prohlédnout památky"],
    ["accommodation", "/əˌkɒməˈdeɪʃn/", "ubytování"],
    ["to get around", "/ə'raʊnd/", "pohybovat se (v okolí)"],
    ["traffic jam", "/ˈtræfɪk dʒæm/", "dopravní zácpa"],
    ["rush hour", "/rʌʃ ˈaʊə/", "dopravní špička"],
    ["public transport", "/ˈpʌblɪk ˈtrænspɔːt/", "veřejná doprava"],
    ["to miss a connection", "/mɪs/", "zmeškat přípoj"],
    ["to check out", "/tʃek aʊt/", "odhlásit se (z hotelu)"],
    ["customs", "/ˈkʌstəmz/", "celnice"],
    ["to go through security", "/sɪˈkjʊərəti/", "projít bezpečnostní kontrolou"],
    ["layover", "/ˈleɪəʊvə/", "mezipřistání"],
    ["to hire a car", "/haɪə/", "půjčit si auto"],
    ["off the beaten track", "/ˈbiːtn træk/", "mimo turistické trasy"],
    ["jet lag", "/dʒet læɡ/", "časový posun"],
  ]],
  ["Jídlo a vaření", [
    ["to chop", "/tʃɒp/", "krájet"],
    ["to grate", "/ɡreɪt/", "strouhat"],
    ["to simmer", "/ˈsɪmə/", "vařit na mírném ohni"],
    ["to season", "/ˈsiːzn/", "dochutit, okořenit"],
    ["to stir", "/stɜː/", "míchat"],
    ["recipe", "/ˈresɪpi/", "recept"],
    ["ingredient", "/ɪnˈɡriːdiənt/", "přísada"],
    ["to taste bland", "/blænd/", "chutnat mdle"],
    ["to be starving", "/ˈstɑːvɪŋ/", "mít strašný hlad"],
    ["takeaway", "/ˈteɪkəweɪ/", "jídlo s sebou"],
    ["to skip a meal", "/skɪp/", "vynechat jídlo"],
    ["leftovers", "/ˈleftəʊvəz/", "zbytky jídla"],
    ["to go off", "/ɡəʊ ɒf/", "zkazit se (o jídle)"],
    ["spicy", "/ˈspaɪsi/", "pikantní"],
    ["processed food", "/ˈprəʊsest fuːd/", "průmyslově zpracované jídlo"],
    ["to overeat", "/ˌəʊvərˈiːt/", "přejídat se"],
    ["staple food", "/ˈsteɪpl fuːd/", "základní potravina"],
    ["to grab a snack", "/ɡræb/", "dát si svačinku"],
    ["to have a sweet tooth", "/swiːt tuːθ/", "mít rád sladké"],
    ["to marinate", "/ˈmærɪneɪt/", "marinovat"],
    ["to overcook", "/ˌəʊvəˈkʊk/", "převařit, přepéct"],
    ["to whisk", "/wɪsk/", "šlehat"],
  ]],
  ["Nakupování a peníze", [
    ["to bargain", "/ˈbɑːɡɪn/", "smlouvat o ceně"],
    ["to be a bargain", "/ˈbɑːɡɪn/", "být výhodná koupě"],
    ["refund", "/ˈriːfʌnd/", "vrácení peněz"],
    ["receipt", "/rɪˈsiːt/", "účtenka"],
    ["to be overpriced", "/ˌəʊvəˈpraɪst/", "být předražený"],
    ["to be on a tight budget", "/ˈbʌdʒɪt/", "mít napjatý rozpočet"],
    ["to save up for something", "/seɪv ʌp/", "šetřit si na něco"],
    ["to be in debt", "/det/", "být zadlužený"],
    ["instalment", "/ɪnˈstɔːlmənt/", "splátka"],
    ["to make ends meet", "/endz miːt/", "vyjít s penězi"],
    ["second-hand", "/ˈsekənd hænd/", "z druhé ruky"],
    ["warranty", "/ˈwɒrənti/", "záruka"],
    ["to return an item", "/rɪˈtɜːn/", "vrátit zboží"],
    ["to be a rip-off", "/rɪp ɒf/", "být zlodějna, přehnaná cena"],
    ["loyalty card", "/ˈlɔɪəlti kɑːd/", "věrnostní karta"],
    ["to splash out", "/splæʃ aʊt/", "utratit hodně za jednu věc"],
    ["to window shop", "/ˈwɪndəʊ ʃɒp/", "chodit se dívat do výloh"],
    ["customer service", "/ˈkʌstəmə ˈsɜːvɪs/", "zákaznický servis"],
    ["to haggle", "/ˈhæɡl/", "smlouvat"],
    ["to be cash-strapped", "/kæʃ stræpt/", "mít nedostatek peněz"],
  ]],
  ["Bydlení", [
    ["to rent a flat", "/rent/", "pronajímat si byt"],
    ["landlord", "/ˈlændlɔːd/", "pronajímatel"],
    ["tenant", "/ˈtenənt/", "nájemník"],
    ["deposit", "/dɪˈpɒzɪt/", "kauce"],
    ["to move in", "/muːv ɪn/", "nastěhovat se"],
    ["to move out", "/muːv aʊt/", "vystěhovat se"],
    ["to renovate", "/ˈrenəveɪt/", "renovovat"],
    ["spacious", "/ˈspeɪʃəs/", "prostorný"],
    ["cosy", "/ˈkəʊzi/", "útulný"],
    ["utility bills", "/juːˈtɪləti bɪlz/", "účty za energie"],
    ["to be fully furnished", "/ˈfɜːnɪʃt/", "být plně zařízený"],
    ["neighbourhood", "/ˈneɪbəhʊd/", "sousedství, čtvrť"],
    ["to do up a house", "/duː ʌp/", "zrekonstruovat dům"],
    ["household chores", "/ˈhaʊshəʊld tʃɔːz/", "domácí práce"],
    ["mortgage", "/ˈmɔːɡɪdʒ/", "hypotéka"],
    ["to be in the middle of nowhere", "/ˈmɪdl əv ˈnəʊweə/", "být na samotě u lesa"],
    ["to sublet", "/ˌsʌbˈlet/", "podnajmout"],
    ["appliance", "/əˈplaɪəns/", "domácí spotřebič"],
    ["draughty", "/ˈdrɑːfti/", "průvanový, studený"],
    ["to be run-down", "/rʌn daʊn/", "být zchátralý"],
  ]],
  ["Počasí a životní prostředí", [
    ["forecast", "/ˈfɔːkɑːst/", "předpověď"],
    ["drizzle", "/ˈdrɪzl/", "mrholení"],
    ["humid", "/ˈhjuːmɪd/", "vlhko, dusno"],
    ["heatwave", "/ˈhiːtweɪv/", "vlna veder"],
    ["to pour with rain", "/pɔː/", "lít jako z konve"],
    ["global warming", "/ˈɡləʊbl ˈwɔːmɪŋ/", "globální oteplování"],
    ["carbon footprint", "/ˈkɑːbən ˈfʊtprɪnt/", "uhlíková stopa"],
    ["renewable energy", "/rɪˈnjuːəbl ˈenədʒi/", "obnovitelná energie"],
    ["to recycle", "/riːˈsaɪkl/", "recyklovat"],
    ["pollution", "/pəˈluːʃn/", "znečištění"],
    ["drought", "/draʊt/", "sucho"],
    ["endangered species", "/ɪnˈdeɪndʒəd ˈspiːʃiːz/", "ohrožený druh"],
    ["sustainable", "/səˈsteɪnəbl/", "udržitelný"],
    ["to conserve resources", "/kənˈsɜːv/", "šetřit zdroje"],
    ["greenhouse gases", "/ˈɡriːnhaʊs ˈɡæsɪz/", "skleníkové plyny"],
    ["deforestation", "/diːˌfɒrɪˈsteɪʃn/", "odlesňování"],
    ["single-use plastic", "/ˈsɪŋɡl juːs ˈplæstɪk/", "jednorázový plast"],
    ["extreme weather", "/ɪkˈstriːm ˈweðə/", "extrémní počasí"],
    ["to have an impact on", "/ˈɪmpækt/", "mít vliv na"],
    ["eco-friendly", "/ˈiːkəʊ ˈfrendli/", "šetrný k životnímu prostředí"],
  ]],
  ["Technologie a média", [
    ["to go viral", "/ˈvaɪərəl/", "stát se virálním"],
    ["to stream a video", "/striːm/", "streamovat video"],
    ["to upload", "/ʌpˈləʊd/", "nahrát (soubor)"],
    ["to charge a battery", "/tʃɑːdʒ/", "nabít baterii"],
    ["device", "/dɪˈvaɪs/", "zařízení"],
    ["to update software", "/ˈʌpdeɪt/", "aktualizovat software"],
    ["to back up files", "/bæk ʌp/", "zálohovat soubory"],
    ["password", "/ˈpɑːswɜːd/", "heslo"],
    ["to hack", "/hæk/", "hacknout, nabourat se"],
    ["screen time", "/skriːn taɪm/", "čas strávený u obrazovky"],
    ["to scroll through", "/skrəʊl/", "listovat, scrollovat"],
    ["fake news", "/feɪk njuːz/", "dezinformace, falešné zprávy"],
    ["to go offline", "/ˈɒflaɪn/", "odpojit se"],
    ["subscription", "/səbˈskrɪpʃn/", "předplatné"],
    ["to livestream", "/ˈlaɪvstriːm/", "vysílat živě"],
    ["to double-check", "/ˈdʌbl tʃek/", "znovu si ověřit"],
    ["social media influencer", "/ˈɪnfluənsə/", "influencer"],
    ["to troubleshoot", "/ˈtrʌblʃuːt/", "řešit technický problém"],
    ["bandwidth", "/ˈbændwɪdθ/", "šířka pásma"],
    ["to unplug", "/ʌnˈplʌɡ/", "odpojit ze zásuvky"],
  ]],
  ["Vztahy a společnost", [
    ["to get along with", "/əˈlɒŋ/", "vycházet s někým"],
    ["to fall out with someone", "/fɔːl aʊt/", "pohádat se s někým"],
    ["to make up", "/meɪk ʌp/", "usmířit se"],
    ["acquaintance", "/əˈkweɪntəns/", "známý (osoba)"],
    ["to keep in touch", "/tʌtʃ/", "udržovat kontakt"],
    ["to grow apart", "/ɡrəʊ əˈpɑːt/", "citově se odcizit"],
    ["to rely on someone", "/rɪˈlaɪ/", "spoléhat se na někoho"],
    ["to look up to someone", "/lʊk ʌp/", "vzhlížet k někomu"],
    ["to let someone down", "/let daʊn/", "zklamat někoho"],
    ["peer pressure", "/pɪə ˈpreʃə/", "tlak vrstevníků"],
    ["to bond with someone", "/bɒnd/", "sblížit se s někým"],
    ["generation gap", "/ˌdʒenəˈreɪʃn ɡæp/", "generační propast"],
    ["to take someone for granted", "/ˈɡrɑːntɪd/", "brát někoho jako samozřejmost"],
    ["upbringing", "/ˈʌpbrɪŋɪŋ/", "výchova"],
    ["to socialise", "/ˈsəʊʃəlaɪz/", "socializovat, stýkat se s lidmi"],
    ["community", "/kəˈmjuːnəti/", "komunita"],
    ["stereotype", "/ˈsteriətaɪp/", "stereotyp"],
    ["diversity", "/daɪˈvɜːsəti/", "různorodost"],
    ["to fit in", "/fɪt ɪn/", "zapadnout, zapadat mezi ostatní"],
    ["to stand out", "/stænd aʊt/", "vyčnívat"],
  ]],
  ["Volný čas a záliby", [
    ["to take up a hobby", "/teɪk ʌp/", "začít se věnovat koníčku"],
    ["to be into something", "/ˈɪntuː/", "bavit se, zajímat se o něco"],
    ["board game", "/bɔːd ɡeɪm/", "deskovka"],
    ["to go for a hike", "/haɪk/", "vyrazit na turistiku"],
    ["gardening", "/ˈɡɑːdnɪŋ/", "zahradničení"],
    ["to collect stamps", "/kəˈlekt/", "sbírat známky"],
    ["do-it-yourself (DIY)", "/diː aɪ waɪ/", "kutilství"],
    ["to binge-watch", "/bɪndʒ wɒtʃ/", "sledovat vše najednou (seriál)"],
    ["to knit", "/nɪt/", "plést"],
    ["leisure activity", "/ˈleʒər ækˈtɪvəti/", "volnočasová aktivita"],
    ["to be a couch potato", "/kaʊtʃ pəˈteɪtəʊ/", "být pohovkový povaleč"],
    ["to sign up for a class", "/saɪn ʌp/", "přihlásit se na kurz"],
    ["competitive", "/kəmˈpetətɪv/", "soutěživý"],
    ["to unwind with a book", "/ʌnˈwaɪnd/", "odreagovat se u knihy"],
    ["pastime", "/ˈpɑːstaɪm/", "koníček, zábava"],
    ["to go camping", "/ˈkæmpɪŋ/", "jet stanovat"],
    ["to be a night owl", "/naɪt aʊl/", "být noční sova"],
    ["to be an early bird", "/ˈɜːli bɜːd/", "být ranní ptáče"],
    ["to indulge in something", "/ɪnˈdʌldʒ/", "dopřát si něco"],
  ]],
  ["Vyjadřování názorů", [
    ["in my opinion", "/əˈpɪnjən/", "podle mého názoru"],
    ["to agree with someone", "/əˈɡriː/", "souhlasit s někým"],
    ["to disagree", "/ˌdɪsəˈɡriː/", "nesouhlasit"],
    ["to have a point", "/pɔɪnt/", "mít pravdu, mít pádný argument"],
    ["to be biased", "/ˈbaɪəst/", "být zaujatý"],
    ["to change one's mind", "/tʃeɪndʒ/", "změnit názor"],
    ["to bring up a topic", "/brɪŋ ʌp/", "nadhodit téma"],
    ["to see both sides", "/saɪdz/", "vidět obě strany věci"],
    ["to argue a case", "/ˈɑːɡjuː/", "argumentovat, hájit stanovisko"],
    ["to make a compromise", "/ˈkɒmprəmaɪz/", "udělat kompromis"],
    ["to play devil's advocate", "/ˈdevlz ˈædvəkət/", "hrát ďáblova advokáta"],
    ["to back up an argument", "/bæk ʌp/", "podložit argument"],
    ["standpoint", "/ˈstændpɔɪnt/", "stanovisko"],
    ["to jump to conclusions", "/dʒʌmp tuː kənˈkluːʒnz/", "dělat unáhlené závěry"],
    ["to weigh up pros and cons", "/weɪ ʌp/", "zvážit pro a proti"],
    ["controversial", "/ˌkɒntrəˈvɜːʃl/", "kontroverzní"],
    ["to speak one's mind", "/spiːk/", "říct otevřeně svůj názor"],
    ["to convince someone", "/kənˈvɪns/", "přesvědčit někoho"],
    ["to have mixed feelings about", "/mɪkst/", "mít o něčem smíšené pocity"],
    ["to be open-minded", "/ˈəʊpən ˈmaɪndɪd/", "být otevřený novým myšlenkám"],
  ]],
  ["Popis vlastností", [
    ["durable", "/ˈdjʊərəbl/", "odolný, trvanlivý"],
    ["fragile", "/ˈfrædʒaɪl/", "křehký"],
    ["efficient", "/ɪˈfɪʃnt/", "efektivní"],
    ["convenient", "/kənˈviːniənt/", "pohodlný, praktický"],
    ["versatile", "/ˈvɜːsətaɪl/", "univerzální, mnohostranný"],
    ["outdated", "/ˌaʊtˈdeɪtɪd/", "zastaralý"],
    ["state-of-the-art", "/steɪt əv ði ɑːt/", "nejmodernější"],
    ["affordable", "/əˈfɔːdəbl/", "cenově dostupný"],
    ["compact", "/kəmˈpækt/", "kompaktní"],
    ["lightweight", "/ˈlaɪtweɪt/", "lehký"],
    ["sturdy", "/ˈstɜːdi/", "pevný, robustní"],
    ["flimsy", "/ˈflɪmzi/", "chatrný"],
    ["bulky", "/ˈbʌlki/", "objemný"],
    ["user-friendly", "/ˈjuːzə ˈfrendli/", "uživatelsky přívětivý"],
    ["innovative", "/ˈɪnəveɪtɪv/", "inovativní"],
    ["practical", "/ˈpræktɪkl/", "praktický"],
    ["high-quality", "/haɪ ˈkwɒləti/", "vysoce kvalitní"],
    ["cutting-edge", "/ˈkʌtɪŋ edʒ/", "špičkový, na hraně technologie"],
    ["adjustable", "/əˈdʒʌstəbl/", "nastavitelný"],
    ["adequate", "/ˈædɪkwət/", "dostatečný, přiměřený"],
    ["faulty", "/ˈfɔːlti/", "vadný"],
    ["waterproof", "/ˈwɔːtəpruːf/", "vodotěsný"],
    ["noticeable", "/ˈnəʊtɪsəbl/", "znatelný, nápadný"],
    ["consistent", "/kənˈsɪstənt/", "konzistentní, důsledný"],
  ]],
  ["Užitečné spojky a fráze", [
    ["however", "/haʊˈevə/", "nicméně"],
    ["on the other hand", "/ˈʌðə hænd/", "na druhou stranu"],
    ["as a result", "/rɪˈzʌlt/", "v důsledku toho"],
    ["therefore", "/ˈðeəfɔː/", "proto"],
    ["in addition", "/əˈdɪʃn/", "navíc"],
    ["apart from that", "/əˈpɑːt/", "kromě toho"],
    ["in spite of", "/spaɪt/", "navzdory"],
    ["even though", "/iːvn ðəʊ/", "i když"],
    ["due to", "/djuː tuː/", "kvůli, z důvodu"],
    ["as long as", "/lɒŋ/", "pokud, dokud"],
    ["unless", "/ʌnˈles/", "pokud ne"],
    ["provided that", "/prəˈvaɪdɪd/", "za předpokladu, že"],
    ["to sum up", "/sʌm ʌp/", "shrnout"],
    ["above all", "/əˈbʌv ɔːl/", "především"],
    ["in the meantime", "/ˈmiːntaɪm/", "mezitím"],
    ["first and foremost", "/ˈfɔːməʊst/", "v první řadě"],
    ["to put it another way", "/əˈnʌðə weɪ/", "jinak řečeno"],
    ["all things considered", "/kənˈsɪdəd/", "se vším všudy, po zvážení"],
    ["for instance", "/ˈɪnstəns/", "například"],
    ["nevertheless", "/ˌnevəðəˈles/", "přesto"],
  ]],
  ["Bezpečnost a zákon", [
    ["to break the law", "/lɔː/", "porušit zákon"],
    ["to be fined", "/faɪnd/", "dostat pokutu"],
    ["witness", "/ˈwɪtnəs/", "svědek"],
    ["to report a crime", "/rɪˈpɔːt/", "nahlásit zločin"],
    ["theft", "/θeft/", "krádež"],
    ["to be robbed", "/rɒbd/", "být okraden"],
    ["to break in", "/breɪk ɪn/", "vloupat se"],
    ["suspicious", "/səˈspɪʃəs/", "podezřelý"],
    ["to press charges", "/tʃɑːdʒɪz/", "podat trestní oznámení"],
    ["evidence", "/ˈevɪdəns/", "důkaz"],
    ["to be arrested", "/əˈrestɪd/", "být zatčen"],
    ["regulation", "/ˌreɡjuˈleɪʃn/", "předpis, nařízení"],
    ["to comply with rules", "/kəmˈplaɪ/", "dodržovat pravidla"],
    ["to be liable for", "/ˈlaɪəbl/", "nést odpovědnost za"],
    ["insurance policy", "/ɪnˈʃʊərəns ˈpɒləsi/", "pojistná smlouva"],
    ["to file a complaint", "/faɪl/", "podat stížnost"],
    ["neighbourhood watch", "/ˈneɪbəhʊd wɒtʃ/", "sousedská hlídka"],
    ["to trespass", "/ˈtrespæs/", "vniknout na cizí pozemek"],
    ["fine print", "/faɪn prɪnt/", "drobné písmo (ve smlouvě)"],
    ["to abide by the rules", "/əˈbaɪd/", "řídit se pravidly"],
    ["to feel queasy", "/ˈkwiːzi/", "být na zvracení"],
    ["to twist an ankle", "/twɪst/", "vyvrtnout si kotník"],
    ["balanced meal", "/ˈbælənst miːl/", "vyvážené jídlo"],
    ["to crave something", "/kreɪv/", "mít na něco chuť"],
    ["to be picky about food", "/ˈpɪki/", "být vybíravý na jídlo"],
    ["light-hearted", "/laɪt ˈhɑːtɪd/", "bezstarostný, veselý"],
    ["dependable", "/dɪˈpendəbl/", "spolehlivý (na koho se dá spolehnout)"],
  ]],
];

const GENERAL_C1_GROUPS = [
  ["Formální spojky", [
    ["nonetheless", "/ˌnʌnðəˈles/", "nicméně, přesto"],
    ["notwithstanding", "/ˌnɒtwɪθˈstændɪŋ/", "navzdory, bez ohledu na"],
    ["insofar as", "/ˌɪnsəˈfɑːr æz/", "pokud jde o, v míře, v jaké"],
    ["with regard to", "/rɪˈɡɑːd/", "pokud jde o, ohledně"],
    ["albeit", "/ɔːlˈbiːɪt/", "ačkoli"],
    ["henceforth", "/ˌhensˈfɔːθ/", "od nynějška, napříště"],
    ["thereby", "/ˌðeəˈbaɪ/", "tím pádem, čímž"],
    ["whereby", "/weəˈbaɪ/", "čímž, na základě čehož"],
    ["conversely", "/kənˈvɜːsli/", "naopak"],
    ["in the same vein", "/veɪn/", "ve stejném duchu"],
    ["by the same token", "/ˈtəʊkən/", "ze stejného důvodu"],
    ["to that end", "/end/", "za tímto účelem"],
    ["on the grounds that", "/ɡraʊndz/", "z důvodu, že"],
    ["given that", "/ˈɡɪvn/", "vzhledem k tomu, že"],
    ["as it stands", "/stændz/", "tak jak to teď je"],
    ["all the more so", "/mɔː səʊ/", "tím spíš"],
    ["in light of", "/laɪt/", "ve světle, s ohledem na"],
    ["for the sake of", "/seɪk/", "kvůli, v zájmu"],
    ["to a certain extent", "/ɪkˈstent/", "do jisté míry"],
    ["by and large", "/baɪ ənd lɑːdʒ/", "vcelku, celkově vzato"],
  ]],
  ["Akademické sloveso", [
    ["to postulate", "/ˈpɒstjuleɪt/", "předpokládat, tvrdit"],
    ["to substantiate", "/səbˈstænʃieɪt/", "doložit, podepřít důkazy"],
    ["to corroborate", "/kəˈrɒbəreɪt/", "potvrdit, podpořit"],
    ["to refute", "/rɪˈfjuːt/", "vyvrátit"],
    ["to extrapolate", "/ɪkˈstræpəleɪt/", "extrapolovat, zobecnit"],
    ["to delineate", "/dɪˈlɪnieɪt/", "vymezit, nastínit"],
    ["to elucidate", "/ɪˈluːsɪdeɪt/", "objasnit"],
    ["to infer", "/ɪnˈfɜː/", "usuzovat, odvodit"],
    ["to underpin", "/ˌʌndəˈpɪn/", "podepřít, být základem"],
    ["to encompass", "/ɪnˈkʌmpəs/", "zahrnovat"],
    ["to constitute", "/ˈkɒnstɪtjuːt/", "tvořit, představovat"],
    ["to attribute something to", "/əˈtrɪbjuːt/", "přisuzovat něco něčemu"],
    ["to reconcile", "/ˈrekənsaɪl/", "sladit, smířit"],
    ["to scrutinise", "/ˈskruːtɪnaɪz/", "podrobně zkoumat"],
    ["to formulate", "/ˈfɔːmjuleɪt/", "formulovat"],
    ["to disseminate", "/dɪˈsemɪneɪt/", "šířit, rozšiřovat"],
    ["to juxtapose", "/ˈdʒʌkstəpəʊz/", "postavit vedle sebe, konfrontovat"],
    ["to circumvent", "/ˌsɜːkəmˈvent/", "obejít (pravidlo, problém)"],
    ["to mitigate", "/ˈmɪtɪɡeɪt/", "zmírnit"],
    ["to exacerbate", "/ɪɡˈzæsəbeɪt/", "zhoršit"],
    ["to permeate", "/ˈpɜːmieɪt/", "prostupovat, prolínat"],
    ["to galvanise", "/ˈɡælvənaɪz/", "podnítit, pobídnout k akci"],
    ["to warrant", "/ˈwɒrənt/", "ospravedlňovat, opravňovat"],
    ["to stem from", "/stem/", "pramenit z, vycházet z"],
    ["to hinge on", "/hɪndʒ/", "záviset na, být podmíněno"],
  ]],
  ["Popis trendů", [
    ["to soar", "/sɔː/", "prudce stoupat"],
    ["to plummet", "/ˈplʌmɪt/", "prudce klesnout"],
    ["to plateau", "/ˈplætəʊ/", "stagnovat, ustálit se"],
    ["to fluctuate", "/ˈflʌktʃueɪt/", "kolísat"],
    ["upward trend", "/ˈʌpwəd trend/", "rostoucí trend"],
    ["to level off", "/ˈlevl ɒf/", "vyrovnat se, stagnovat"],
    ["marginal increase", "/ˈmɑːdʒɪnl/", "nepatrný nárůst"],
    ["exponential growth", "/ˌekspəˈnenʃl ɡrəʊθ/", "exponenciální růst"],
    ["to taper off", "/ˈteɪpər ɒf/", "postupně slábnout, ustupovat"],
    ["steady decline", "/ˈstedi dɪˈklaɪn/", "trvalý pokles"],
    ["to peak", "/piːk/", "dosáhnout vrcholu"],
    ["to bottom out", "/ˈbɒtəm aʊt/", "dosáhnout dna"],
    ["a sharp downturn", "/ʃɑːp ˈdaʊntɜːn/", "prudký propad"],
    ["incremental change", "/ˌɪŋkrəˈmentl tʃeɪndʒ/", "postupná změna"],
    ["to gain momentum", "/məˈmentəm/", "nabírat na síle, dynamice"],
    ["to level out", "/ˈlevl aʊt/", "vyrovnat se"],
    ["a slight dip", "/slaɪt dɪp/", "mírný propad"],
    ["to be on the rise", "/raɪz/", "být na vzestupu"],
    ["volatile", "/ˈvɒlətaɪl/", "nestálý, kolísavý"],
    ["stagnant", "/ˈstæɡnənt/", "stagnující"],
  ]],
  ["Zdvořilé zmírnění", [
    ["arguably", "/ˈɑːɡjuəbli/", "dalo by se říct, patrně"],
    ["to some extent", "/ɪkˈstent/", "do jisté míry"],
    ["it could be argued that", "/ˈɑːɡjuːd/", "dalo by se argumentovat, že"],
    ["presumably", "/prɪˈzjuːməbli/", "pravděpodobně, patrně"],
    ["ostensibly", "/ɒˈstensəbli/", "zdánlivě, navenek"],
    ["purportedly", "/pəˈpɔːtɪdli/", "údajně"],
    ["supposedly", "/səˈpəʊzɪdli/", "údajně, prý"],
    ["seemingly", "/ˈsiːmɪŋli/", "zdánlivě"],
    ["apparently", "/əˈpærəntli/", "zřejmě, jak se zdá"],
    ["it would seem that", "/siːm/", "zdá se, že"],
    ["one could say that", "/kʊd/", "dalo by se říct, že"],
    ["to a large degree", "/dɪˈɡriː/", "z velké míry"],
    ["broadly speaking", "/ˈbrɔːdli/", "obecně řečeno"],
    ["strictly speaking", "/ˈstrɪktli/", "přísně vzato"],
    ["to put it mildly", "/ˈmaɪldli/", "mírně řečeno"],
    ["more often than not", "/ˈɒfn/", "většinou, zpravidla"],
    ["as far as I am aware", "/əˈweə/", "pokud vím"],
    ["to the best of my knowledge", "/ˈnɒlɪdʒ/", "podle mých nejlepších znalostí"],
  ]],
  ["Pokročilé přídavné jméno", [
    ["meticulous", "/məˈtɪkjələs/", "puntičkářský, důkladný"],
    ["resilient", "/rɪˈzɪliənt/", "odolný, houževnatý"],
    ["pragmatic", "/præɡˈmætɪk/", "pragmatický"],
    ["versatile", "/ˈvɜːsətaɪl/", "všestranný"],
    ["audacious", "/ɔːˈdeɪʃəs/", "smělý, troufalý"],
    ["tenacious", "/təˈneɪʃəs/", "vytrvalý, neústupný"],
    ["prudent", "/ˈpruːdnt/", "prozíravý, obezřetný"],
    ["candid", "/ˈkændɪd/", "upřímný, otevřený"],
    ["eloquent", "/ˈeləkwənt/", "výřečný"],
    ["astute", "/əˈstjuːt/", "bystrý, prohnaný"],
    ["pertinent", "/ˈpɜːtɪnənt/", "relevantní, případný"],
    ["ambivalent", "/æmˈbɪvələnt/", "ambivalentní, rozporuplný"],
    ["indispensable", "/ˌɪndɪˈspensəbl/", "nepostradatelný"],
    ["prevalent", "/ˈprevələnt/", "převládající, rozšířený"],
    ["unprecedented", "/ʌnˈpresɪdentɪd/", "bezprecedentní"],
    ["plausible", "/ˈplɔːzəbl/", "věrohodný, pravděpodobný"],
    ["inherent", "/ɪnˈhɪərənt/", "vlastní, inherentní"],
    ["intricate", "/ˈɪntrɪkət/", "spletitý, komplikovaný"],
    ["meagre", "/ˈmiːɡə/", "nepatrný, skrovný"],
    ["compelling", "/kəmˈpelɪŋ/", "přesvědčivý, poutavý"],
    ["elusive", "/ɪˈluːsɪv/", "nepolapitelný, těžko dosažitelný"],
    ["staggering", "/ˈstæɡərɪŋ/", "ohromující"],
    ["meticulously", "/məˈtɪkjələsli/", "puntičkářsky, pečlivě"],
    ["formidable", "/ˈfɔːmɪdəbl/", "impozantní, obávaný"],
  ]],
  ["Byznys a ekonomika", [
    ["revenue", "/ˈrevənjuː/", "výnosy, tržby"],
    ["profit margin", "/ˈprɒfɪt ˈmɑːdʒɪn/", "zisková marže"],
    ["to break even", "/breɪk ˈiːvn/", "dosáhnout bodu zvratu"],
    ["shareholder", "/ˈʃeəhəʊldə/", "akcionář"],
    ["merger", "/ˈmɜːdʒə/", "fúze"],
    ["acquisition", "/ˌækwɪˈzɪʃn/", "akvizice"],
    ["to downsize", "/ˈdaʊnsaɪz/", "zeštíhlit, propouštět"],
    ["supply chain", "/səˈplaɪ tʃeɪn/", "dodavatelský řetězec"],
    ["to outsource", "/ˈaʊtsɔːs/", "zadat externí firmě"],
    ["market share", "/ˈmɑːkɪt ʃeə/", "podíl na trhu"],
    ["stakeholder", "/ˈsteɪkhəʊldə/", "zainteresovaná strana"],
    ["liquidity", "/lɪˈkwɪdəti/", "likvidita"],
    ["to go bankrupt", "/ˈbæŋkrʌpt/", "zkrachovat"],
    ["subsidiary", "/səbˈsɪdiəri/", "dceřiná společnost"],
    ["overhead costs", "/ˈəʊvəhed kɒsts/", "režijní náklady"],
    ["to streamline processes", "/ˈstriːmlaɪn/", "zefektivnit procesy"],
    ["recession", "/rɪˈseʃn/", "recese"],
    ["inflation rate", "/ɪnˈfleɪʃn reɪt/", "míra inflace"],
    ["to diversify", "/daɪˈvɜːsɪfaɪ/", "diverzifikovat"],
    ["venture capital", "/ˈventʃə ˈkæpɪtl/", "rizikový kapitál"],
    ["to underpin the economy", "/ˌʌndəˈpɪn/", "být oporou ekonomiky"],
    ["fiscal policy", "/ˈfɪskl ˈpɒləsi/", "fiskální politika"],
    ["to yield a return", "/jiːld/", "přinést výnos"],
    ["turnover", "/ˈtɜːnəʊvə/", "obrat"],
  ]],
  ["Politika a společnost", [
    ["legislation", "/ˌledʒɪsˈleɪʃn/", "legislativa"],
    ["to enact a law", "/ɪˈnækt/", "vydat, přijmout zákon"],
    ["constituency", "/kənˈstɪtjuənsi/", "volební obvod"],
    ["to lobby for something", "/ˈlɒbi/", "lobbovat za něco"],
    ["bureaucracy", "/bjʊəˈrɒkrəsi/", "byrokracie"],
    ["to implement a policy", "/ˈɪmplɪment/", "zavést politiku, opatření"],
    ["accountability", "/əˌkaʊntəˈbɪləti/", "odpovědnost, zodpovědnost"],
    ["referendum", "/ˌrefəˈrendəm/", "referendum"],
    ["to grant asylum", "/əˈsaɪləm/", "udělit azyl"],
    ["sovereignty", "/ˈsɒvrənti/", "suverenita"],
    ["to curb inflation", "/kɜːb/", "krotit inflaci"],
    ["welfare state", "/ˈwelfeə steɪt/", "sociální stát"],
    ["civil liberties", "/ˈsɪvl ˈlɪbətiz/", "občanské svobody"],
    ["to marginalise a group", "/ˈmɑːdʒɪnəlaɪz/", "marginalizovat, vytlačit na okraj"],
    ["polarised society", "/ˈpəʊləraɪzd/", "polarizovaná společnost"],
    ["grassroots movement", "/ˈɡrɑːsruːts/", "hnutí zdola"],
    ["to hold someone accountable", "/əˈkaʊntəbl/", "činit někoho zodpovědným"],
    ["watchdog", "/ˈwɒtʃdɒɡ/", "dozorčí orgán, hlídací pes"],
    ["to undermine trust", "/ˌʌndəˈmaɪn/", "podkopat důvěru"],
  ]],
  ["Abstraktní podstatná jména", [
    ["implication", "/ˌɪmplɪˈkeɪʃn/", "důsledek, implikace"],
    ["ramification", "/ˌræmɪfɪˈkeɪʃn/", "dopad, důsledek"],
    ["premise", "/ˈpremɪs/", "premisa, výchozí předpoklad"],
    ["paradox", "/ˈpærədɒks/", "paradox"],
    ["dilemma", "/dɪˈlemə/", "dilema"],
    ["discrepancy", "/dɪˈskrepənsi/", "nesrovnalost"],
    ["ambiguity", "/ˌæmbɪˈɡjuːəti/", "nejednoznačnost"],
    ["nuance", "/ˈnjuːɑːns/", "nuance, odstín"],
    ["catalyst", "/ˈkætəlɪst/", "katalyzátor"],
    ["momentum", "/məˈmentəm/", "dynamika, setrvačnost"],
    ["resilience", "/rɪˈzɪliəns/", "odolnost"],
    ["scepticism", "/ˈskeptɪsɪzəm/", "skepse"],
    ["integrity", "/ɪnˈteɡrəti/", "integrita, bezúhonnost"],
    ["paradigm", "/ˈpærədaɪm/", "paradigma"],
    ["legacy", "/ˈleɡəsi/", "odkaz, dědictví"],
    ["repercussion", "/ˌriːpəˈkʌʃn/", "následek, dopad"],
    ["controversy", "/ˈkɒntrəvɜːsi/", "kontroverze"],
    ["precedent", "/ˈpresɪdənt/", "precedens"],
    ["consensus", "/kənˈsensəs/", "konsenzus"],
    ["incentive", "/ɪnˈsentɪv/", "pobídka, motivace"],
    ["threshold", "/ˈθreʃhəʊld/", "práh, hranice"],
  ]],
  ["Kolokace a fráze", [
    ["to strike a balance", "/straɪk/", "najít rovnováhu"],
    ["to draw a parallel", "/drɔː/", "přirovnat, udělat paralelu"],
    ["to set a precedent", "/set/", "vytvořit precedens"],
    ["to bear in mind", "/beə/", "mít na paměti"],
    ["to take something into account", "/əˈkaʊnt/", "vzít něco v úvahu"],
    ["to come to terms with", "/tɜːmz/", "smířit se s"],
    ["to shed light on", "/ʃed/", "vrhnout světlo na"],
    ["to pave the way for", "/peɪv/", "připravit půdu pro"],
    ["to raise the bar", "/reɪz/", "zvýšit laťku"],
    ["to be at the forefront of", "/ˈfɔːfrʌnt/", "být v čele, v popředí"],
    ["to be a double-edged sword", "/ˈedʒd sɔːd/", "být dvousečná zbraň"],
    ["to be in the pipeline", "/ˈpaɪplaɪn/", "být připravováno, v procesu"],
    ["to hit the nail on the head", "/neɪl/", "trefit hřebík na hlavičku"],
    ["to be a driving force", "/ˈdraɪvɪŋ fɔːs/", "být hnací silou"],
    ["to gain traction", "/ˈtrækʃn/", "získávat na síle, popularitě"],
    ["to tip the scales", "/tɪp ðə skeɪlz/", "převážit misku vah"],
    ["to set the record straight", "/rɪˈkɔːd streɪt/", "uvést věci na pravou míru"],
    ["to be food for thought", "/fuːd fə θɔːt/", "dát k zamyšlení"],
  ]],
  ["Diskusní markery", [
    ["that being said", "/biːɪŋ sed/", "nicméně, přesto"],
    ["having said that", "/hævɪŋ sed/", "i tak, nicméně"],
    ["to put things into perspective", "/pəˈspektɪv/", "uvést věci na pravou míru"],
    ["all things being equal", "/ˈiːkwəl/", "za jinak stejných okolností"],
    ["as things stand", "/stænd/", "tak jak to teď vypadá"],
    ["to cut a long story short", "/kʌt/", "zkráceně řečeno"],
    ["needless to say", "/ˈniːdləs/", "netřeba dodávat"],
    ["for what it's worth", "/wɜːθ/", "za zmínku stojí, ať je to platné jak chce"],
    ["at the end of the day", "/deɪ/", "koneckonců"],
    ["when it comes down to it", "/kʌmz daʊn/", "když na to přijde"],
    ["to touch on a topic", "/tʌtʃ/", "dotknout se tématu"],
    ["to digress", "/daɪˈɡres/", "odbočit od tématu"],
    ["to reiterate", "/riˈɪtəreɪt/", "zopakovat, znovu zdůraznit"],
    ["on a related note", "/rɪˈleɪtɪd/", "v souvislosti s tím"],
    ["to circle back to", "/ˈsɜːkl bæk/", "vrátit se k tématu"],
  ]],
  ["Přesvědčování", [
    ["to make a compelling case", "/kəmˈpelɪŋ/", "podat přesvědčivý argument"],
    ["to appeal to reason", "/əˈpiːl/", "apelovat na rozum"],
    ["to sway public opinion", "/sweɪ/", "ovlivnit veřejné mínění"],
    ["to drive home a point", "/draɪv həʊm/", "důrazně zdůraznit"],
    ["to build a rapport", "/ræˈpɔː/", "vybudovat vzájemný vztah, důvěru"],
    ["to strike a chord", "/kɔːd/", "zasáhnout citlivou strunu"],
    ["to capitalise on something", "/ˈkæpɪtəlaɪz/", "vytěžit z něčeho maximum"],
    ["to play on emotions", "/pleɪ ɒn/", "hrát na city"],
    ["to spin a narrative", "/spɪn/", "vytvořit záměrně zabarvený příběh"],
    ["to gain leverage", "/ˈliːvərɪdʒ/", "získat páku, vliv"],
    ["to make concessions", "/kənˈseʃnz/", "dělat ústupky"],
    ["to appeal to common sense", "/ˈkɒmən sens/", "apelovat na zdravý rozum"],
  ]],
  ["Frázová slovesa - pokročilá", [
    ["to delve into", "/delv/", "ponořit se do, prozkoumat do hloubky"],
    ["to branch out", "/brɑːntʃ aʊt/", "rozšířit svoji činnost"],
    ["to iron out issues", "/ˈaɪən aʊt/", "vyřešit problémy"],
    ["to phase out", "/feɪz aʊt/", "postupně vyřadit z provozu"],
    ["to bring about change", "/brɪŋ əˈbaʊt/", "přinést, vyvolat změnu"],
    ["to carry through", "/ˈkæri θruː/", "dotáhnout do konce"],
    ["to hold off on something", "/həʊld ɒf/", "odložit, počkat s něčím"],
    ["to grapple with a problem", "/ˈɡræpl/", "potýkat se s problémem"],
    ["to weed out", "/wiːd aʊt/", "vyřadit, odstranit nevhodné"],
    ["to level with someone", "/ˈlevl/", "mluvit s někým na rovinu"],
    ["to spell out", "/spel aʊt/", "podrobně vysvětlit"],
    ["to tide someone over", "/taɪd ˈəʊvə/", "pomoct někomu překlenout těžké období"],
    ["to chip away at", "/tʃɪp əˈweɪ/", "postupně ukrajovat, snižovat"],
    ["to home in on", "/həʊm ɪn/", "zaměřit se přesně na"],
    ["to gloss over", "/ɡlɒs ˈəʊvə/", "přejít bez povšimnutí, zlehčit"],
  ]],
  ["Emoce a nuance", [
    ["to be disillusioned", "/ˌdɪsɪˈluːʒnd/", "být rozčarovaný"],
    ["to feel disheartened", "/dɪsˈhɑːtnd/", "cítit se skleslý, sklíčený"],
    ["to be apprehensive", "/ˌæprɪˈhensɪv/", "mít obavy, být nervózní"],
    ["to be indifferent to", "/ɪnˈdɪfrənt/", "být lhostejný k"],
    ["to feel a sense of unease", "/ʌnˈiːz/", "cítit neklid"],
    ["to be taken aback", "/əˈbæk/", "být překvapený, zaskočený"],
    ["to harbour resentment", "/ˈhɑːbə rɪˈzentmənt/", "chovat zášť"],
    ["to feel a pang of guilt", "/pæŋ/", "pocítit bodnutí viny"],
    ["to be on edge", "/edʒ/", "být nervózní, ve stresu"],
    ["to be overcome with emotion", "/ˌəʊvəˈkʌm/", "být přemožen emocemi"],
    ["to feel a sense of closure", "/ˈkləʊʒə/", "cítit uzavření (kapitoly)"],
    ["to be at peace with something", "/piːs/", "být s něčím smířený"],
    ["to be wistful", "/ˈwɪstfl/", "být toužebně zasněný, nostalgický"],
    ["to feel a twinge of regret", "/twɪndʒ/", "pocítit náznak lítosti"],
  ]],
  ["Popis problémů", [
    ["to be a pressing issue", "/ˈpresɪŋ/", "být naléhavý problém"],
    ["to reach a stalemate", "/ˈsteɪlmeɪt/", "dostat se do patové situace"],
    ["to be at a crossroads", "/ˈkrɒsrəʊdz/", "být na rozcestí"],
    ["to be an uphill battle", "/ˈʌphɪl/", "být boj do kopce"],
    ["to hit a snag", "/snæɡ/", "narazit na zádrhel"],
    ["to be a recurring problem", "/rɪˈkɜːrɪŋ/", "být opakující se problém"],
    ["root cause", "/ruːt kɔːz/", "kořenová příčina"],
    ["to reach a deadlock", "/ˈdedlɒk/", "dostat se do slepé uličky"],
    ["to be a vicious circle", "/ˈvɪʃəs/", "být začarovaný kruh"],
    ["underlying issue", "/ˌʌndəˈlaɪɪŋ/", "podkladový, skrytý problém"],
    ["to exacerbate a situation", "/ɪɡˈzæsəbeɪt/", "zhoršit situaci"],
    ["to be a slippery slope", "/ˈslɪpəri sləʊp/", "být kluzký svah (nebezpečný trend)"],
  ]],
  ["Vědecký jazyk", [
    ["hypothesis", "/haɪˈpɒθəsɪs/", "hypotéza"],
    ["to yield results", "/jiːld/", "přinést výsledky"],
    ["empirical evidence", "/ɪmˈpɪrɪkl/", "empirický důkaz"],
    ["methodology", "/ˌmeθəˈdɒlədʒi/", "metodologie"],
    ["to replicate a study", "/ˈreplɪkeɪt/", "replikovat studii"],
    ["variable", "/ˈveəriəbl/", "proměnná"],
    ["correlation", "/ˌkɒrəˈleɪʃn/", "korelace"],
    ["causation", "/kɔːˈzeɪʃn/", "kauzalita, příčinná souvislost"],
    ["to draw a conclusion", "/kənˈkluːʒn/", "vyvodit závěr"],
    ["sample size", "/ˈsɑːmpl saɪz/", "velikost vzorku"],
    ["bias", "/ˈbaɪəs/", "zkreslení, předpojatost"],
    ["peer-reviewed", "/pɪə rɪˈvjuːd/", "recenzovaný odborníky"],
    ["to falsify a theory", "/ˈfɔːlsɪfaɪ/", "vyvrátit teorii"],
    ["anomaly", "/əˈnɒməli/", "anomálie"],
    ["longitudinal study", "/ˌlɒndʒɪˈtjuːdɪnl/", "dlouhodobá studie"],
    ["to be inconclusive", "/ˌɪnkənˈkluːsɪv/", "být neprůkazný"],
    ["qualitative data", "/ˈkwɒlɪtətɪv/", "kvalitativní data"],
    ["to skew results", "/skjuː/", "zkreslit výsledky"],
    ["benchmark", "/ˈbentʃmɑːk/", "měřítko, srovnávací standard"],
    ["to validate findings", "/ˈvælɪdeɪt/", "ověřit zjištění"],
  ]],
  ["Popis změn a procesů", [
    ["to undergo a transformation", "/ˌʌndəˈɡəʊ/", "projít proměnou"],
    ["gradual shift", "/ˈɡrædʒuəl ʃɪft/", "postupný posun"],
    ["to overhaul a system", "/ˈəʊvəhɔːl/", "zásadně přepracovat systém"],
    ["to phase something in", "/feɪz ɪn/", "postupně zavádět"],
    ["to revamp", "/riːˈvæmp/", "zmodernizovat, přepracovat"],
    ["watershed moment", "/ˈwɔːtəʃed/", "přelomový okamžik"],
    ["to consolidate gains", "/kənˈsɒlɪdeɪt/", "upevnit dosažené výsledky"],
    ["to spearhead a project", "/ˈspɪəhed/", "vést, stát v čele projektu"],
    ["to streamline a process", "/ˈstriːmlaɪn/", "zefektivnit proces"],
    ["irreversible", "/ˌɪrɪˈvɜːsəbl/", "nevratný"],
    ["to reshape", "/riːˈʃeɪp/", "přetvořit, přeformovat"],
    ["transitional period", "/trænˈzɪʃənl/", "přechodné období"],
    ["to institute reforms", "/ˈɪnstɪtjuːt/", "zavést reformy"],
    ["paradigm shift", "/ˈpærədaɪm ʃɪft/", "zásadní změna paradigmatu"],
    ["to be in a state of flux", "/flʌks/", "být v neustálém pohybu, měnit se"],
  ]],
  ["Kultura a umění", [
    ["to portray", "/pɔːˈtreɪ/", "vylíčit, zobrazit"],
    ["narrative", "/ˈnærətɪv/", "vyprávění, narativ"],
    ["to evoke emotion", "/ɪˈvəʊk/", "vyvolat emoci"],
    ["aesthetic", "/iːsˈθetɪk/", "estetický"],
    ["to be a masterpiece", "/ˈmɑːstəpiːs/", "být mistrovské dílo"],
    ["to critique a work", "/krɪˈtiːk/", "kritizovat, hodnotit dílo"],
    ["cultural heritage", "/ˈkʌltʃərəl ˈherɪtɪdʒ/", "kulturní dědictví"],
    ["to be avant-garde", "/ˌævɒŋ ˈɡɑːd/", "být avantgardní"],
    ["symbolism", "/ˈsɪmbəlɪzəm/", "symbolika"],
    ["to romanticise", "/rəʊˈmæntɪsaɪz/", "romantizovat"],
    ["to be thought-provoking", "/prəˈvəʊkɪŋ/", "podněcovat k zamyšlení"],
    ["subtext", "/ˈsʌbtekst/", "skrytý význam, podtext"],
    ["to draw inspiration from", "/ˌɪnspəˈreɪʃn/", "čerpat inspiraci z"],
  ]],
  ["Pokročilé životní prostředí", [
    ["carbon neutrality", "/ˈkɑːbən njuːˈtræləti/", "uhlíková neutralita"],
    ["to offset emissions", "/ˈɒfset/", "kompenzovat emise"],
    ["biodiversity loss", "/ˌbaɪəʊdaɪˈvɜːsəti/", "úbytek biodiverzity"],
    ["ecosystem", "/ˈiːkəʊsɪstəm/", "ekosystém"],
    ["to be unsustainable", "/ˌʌnsəˈsteɪnəbl/", "být neudržitelný"],
    ["environmental degradation", "/dɪˌɡreɪˈdeɪʃn/", "poškozování životního prostředí"],
    ["circular economy", "/ˈsɜːkjələ ɪˈkɒnəmi/", "cirkulární ekonomika"],
    ["to phase out fossil fuels", "/ˈfɒsl fjuːəlz/", "postupně opustit fosilní paliva"],
    ["tipping point", "/ˈtɪpɪŋ pɔɪnt/", "bod zlomu"],
    ["to mitigate climate change", "/ˈmɪtɪɡeɪt/", "zmírnit klimatickou změnu"],
    ["carbon capture", "/ˈkɑːbən ˈkæptʃə/", "zachytávání uhlíku"],
  ]],
  ["Psychologie a chování", [
    ["cognitive bias", "/ˈkɒɡnətɪv ˈbaɪəs/", "kognitivní zkreslení"],
    ["to rationalise behaviour", "/ˈræʃənəlaɪz/", "racionalizovat chování"],
    ["subconscious", "/ˌsʌbˈkɒnʃəs/", "podvědomí"],
    ["to internalise", "/ɪnˈtɜːnəlaɪz/", "zvnitřnit"],
    ["self-fulfilling prophecy", "/self fʊlˈfɪlɪŋ ˈprɒfəsi/", "sebenaplňující se proroctví"],
    ["to project one's feelings", "/ˈprɒdʒekt/", "promítat své pocity"],
    ["resilience", "/rɪˈzɪliəns/", "psychická odolnost"],
    ["to conform to norms", "/kənˈfɔːm/", "přizpůsobit se normám"],
    ["innate", "/ɪˈneɪt/", "vrozený"],
    ["to be conditioned to", "/kənˈdɪʃnd/", "být podmíněný, naučený k"],
    ["motivation", "/ˌməʊtɪˈveɪʃn/", "motivace"],
    ["to suppress an impulse", "/səˈpres/", "potlačit impuls"],
  ]],
  ["Míra jistoty", [
    ["beyond doubt", "/daʊt/", "nade vši pochybnost"],
    ["in all likelihood", "/ˈlaɪklihʊd/", "se vší pravděpodobností"],
    ["it stands to reason that", "/rɪˈzn/", "je logické, že"],
    ["there is every indication that", "/ˌɪndɪˈkeɪʃn/", "vše nasvědčuje tomu, že"],
    ["it remains to be seen", "/rɪˈmeɪnz/", "teprve se ukáže"],
    ["by no means certain", "/ˈsɜːtn/", "zdaleka ne jisté"],
    ["a foregone conclusion", "/ˈfɔːɡɒn/", "předem daný závěr"],
    ["to cast doubt on", "/kɑːst daʊt/", "zpochybnit"],
    ["inconclusive evidence", "/ˌɪnkənˈkluːsɪv/", "neprůkazný důkaz"],
    ["to take something with a pinch of salt", "/pɪntʃ/", "brát něco s rezervou"],
  ]],
  ["Právní a formální jazyk", [
    ["to be bound by contract", "/baʊnd/", "být vázán smlouvou"],
    ["clause", "/klɔːz/", "doložka, klauzule"],
    ["to breach an agreement", "/briːtʃ/", "porušit dohodu"],
    ["liability", "/ˌlaɪəˈbɪləti/", "právní odpovědnost"],
    ["to waive a right", "/weɪv/", "vzdát se práva"],
    ["null and void", "/nʌl ənd vɔɪd/", "neplatný, zrušený"],
    ["to indemnify", "/ɪnˈdemnɪfaɪ/", "odškodnit"],
    ["binding agreement", "/ˈbaɪndɪŋ/", "závazná dohoda"],
    ["to comply with regulations", "/kəmˈplaɪ/", "dodržovat předpisy"],
    ["statutory requirement", "/ˈstætjətəri/", "zákonný požadavek"],
    ["to be exempt from", "/ɪɡˈzempt/", "být osvobozen od"],
    ["jurisdiction", "/ˌdʒʊərɪsˈdɪkʃn/", "jurisdikce, pravomoc"],
    ["to litigate", "/ˈlɪtɪɡeɪt/", "vést soudní spor"],
    ["plaintiff", "/ˈpleɪntɪf/", "žalobce"],
    ["to be held liable", "/ˈlaɪəbl/", "nést odpovědnost"],
  ]],
  ["Historie a společnost", [
    ["to dwindle", "/ˈdwɪndl/", "postupně ubývat, slábnout"],
    ["to be deeply rooted in", "/ruːtɪd/", "být hluboce zakořeněný v"],
    ["a turning point", "/ˈtɜːnɪŋ pɔɪnt/", "zlomový bod"],
    ["to be a relic of the past", "/ˈrelɪk/", "být pozůstatkem minulosti"],
    ["to reshape society", "/riːˈʃeɪp/", "přetvořit společnost"],
    ["social upheaval", "/ʌpˈhiːvl/", "společenský otřes"],
    ["to be steeped in tradition", "/stiːpt/", "být prosáklý tradicí"],
    ["to break with tradition", "/breɪk/", "porušit tradici"],
    ["collective memory", "/kəˈlektɪv/", "kolektivní paměť"],
    ["to be at a historic juncture", "/ˈdʒʌŋktʃə/", "být v historickém bodě zlomu"],
    ["to commemorate", "/kəˈmeməreɪt/", "připomínat si, uctívat památku"],
  ]],
  ["Idiomy - pokročilé", [
    ["to read between the lines", "/laɪnz/", "číst mezi řádky"],
    ["to be a blessing in disguise", "/dɪsˈɡaɪz/", "být požehnáním v přestrojení"],
    ["to be the tip of the iceberg", "/ˈaɪsbɜːɡ/", "být jen špička ledovce"],
    ["to go back to the drawing board", "/ˈdrɔːɪŋ bɔːd/", "vrátit se k rýsovacímu prknu"],
    ["to jump on the bandwagon", "/ˈbændwæɡən/", "naskočit na vlnu"],
    ["to be at loggerheads", "/ˈlɒɡəhedz/", "být ve sporu, neshodovat se"],
    ["to move the goalposts", "/ˈɡəʊlpəʊsts/", "měnit pravidla za chodu"],
    ["to be a game changer", "/ɡeɪm ˈtʃeɪndʒə/", "zásadně změnit situaci"],
    ["to throw someone under the bus", "/bʌs/", "hodit někoho přes palubu"],
    ["to take something with a grain of salt", "/ɡreɪn/", "brát něco s rezervou"],
    ["to be on the same page", "/peɪdʒ/", "být na stejné vlně, mít shodný názor"],
    ["to bite the bullet", "/ˈbʊlɪt/", "kousnout do kyselého jablka"],
    ["to cut corners", "/ˈkɔːnəz/", "šidit práci, dělat věci polovičatě"],
  ]],
  ["Registr a styl", [
    ["to convey a message", "/kənˈveɪ/", "sdělit, předat zprávu"],
    ["to articulate a view", "/ɑːˈtɪkjuleɪt/", "jasně vyjádřit názor"],
    ["succinct", "/səkˈsɪŋkt/", "výstižný, stručný"],
    ["verbose", "/vɜːˈbəʊs/", "upovídaný, mnohomluvný"],
    ["to be terse", "/tɜːs/", "být strohý, úsečný"],
    ["colloquial", "/kəˈləʊkwiəl/", "hovorový"],
    ["to paraphrase", "/ˈpærəfreɪz/", "parafrázovat"],
    ["tone of voice", "/təʊn/", "tón hlasu"],
    ["to come across as", "/kʌm əˈkrɒs/", "působit jako, vyznít jako"],
    ["nuanced", "/ˈnjuːɑːnst/", "jemně odstíněný"],
    ["to overstate", "/ˌəʊvəˈsteɪt/", "přehánět, nadsazovat"],
    ["to understate", "/ˌʌndəˈsteɪt/", "podceňovat, zlehčovat"],
  ]],
  ["Doplňkové pojmy", [
    ["to be conducive to", "/kənˈdjuːsɪv/", "prospívat, být příznivé pro"],
    ["to be at variance with", "/ˈveəriəns/", "být v rozporu s"],
    ["to be predicated on", "/ˈpredɪkeɪtɪd/", "být založený na, podmíněný"],
    ["to be a stopgap solution", "/ˈstɒpɡæp/", "být provizorní řešení"],
    ["to be tantamount to", "/ˈtæntəmaʊnt/", "rovnat se, být totéž co"],
    ["to be commensurate with", "/kəˈmenʃərət/", "úměrný, odpovídající"],
    ["to be a fait accompli", "/feɪt əˈkɒmpli/", "být hotová věc"],
    ["to skew the outcome", "/skjuː/", "zkreslit výsledek"],
    ["to be in the same boat", "/bəʊt/", "být na tom stejně"],
    ["to reach a tipping point", "/ˈtɪpɪŋ/", "dosáhnout bodu zlomu"],
    ["to be a case in point", "/pɔɪnt/", "být ukázkovým příkladem"],
    ["to set a benchmark", "/ˈbentʃmɑːk/", "stanovit měřítko, standard"],
  ]],
];

const MECH_ENG_GROUPS = [
  ["Materiály", [
    ["alloy", "/ˈælɔɪ/", "slitina"],
    ["stainless steel", "/ˈsteɪnləs stiːl/", "nerezová ocel"],
    ["carbon steel", "/ˈkɑːbən stiːl/", "uhlíková ocel"],
    ["cast iron", "/kɑːst ˈaɪən/", "litina"],
    ["aluminium", "/ˌæljəˈmɪniəm/", "hliník"],
    ["brass", "/brɑːs/", "mosaz"],
    ["bronze", "/brɒnz/", "bronz"],
    ["composite material", "/kəmˈpɒzɪt/", "kompozitní materiál"],
    ["yield strength", "/jiːld streŋθ/", "mez kluzu"],
    ["tensile strength", "/ˈtensaɪl/", "mez pevnosti v tahu"],
    ["ductility", "/dʌkˈtɪləti/", "tažnost"],
    ["hardness", "/ˈhɑːdnəs/", "tvrdost"],
    ["brittleness", "/ˈbrɪtlnəs/", "křehkost"],
    ["fatigue resistance", "/fəˈtiːɡ rɪˈzɪstəns/", "odolnost proti únavě materiálu"],
    ["heat treatment", "/hiːt ˈtriːtmənt/", "tepelné zpracování"],
    ["annealing", "/əˈniːlɪŋ/", "žíhání"],
    ["quenching", "/ˈkwentʃɪŋ/", "kalení"],
    ["tempering", "/ˈtempərɪŋ/", "popouštění"],
    ["grain structure", "/ɡreɪn ˈstrʌktʃə/", "struktura zrna materiálu"],
    ["corrosion resistance", "/kəˈrəʊʒn/", "odolnost proti korozi"],
    ["thermal expansion", "/ˈθɜːml ɪkˈspænʃn/", "tepelná roztažnost"],
    ["melting point", "/ˈmeltɪŋ pɔɪnt/", "teplota tání"],
    ["raw material", "/rɔː məˈtɪəriəl/", "surovina"],
    ["material fatigue", "/məˈtɪəriəl fəˈtiːɡ/", "únava materiálu"],
  ]],
  ["Obrábění a výroba", [
    ["to machine a part", "/məˈʃiːn/", "obrábět součást"],
    ["lathe", "/leɪð/", "soustruh"],
    ["milling machine", "/ˈmɪlɪŋ məˈʃiːn/", "frézka"],
    ["CNC machining", "/siː en siː/", "CNC obrábění"],
    ["to drill a hole", "/drɪl/", "vyvrtat otvor"],
    ["to mill a surface", "/mɪl/", "frézovat plochu"],
    ["to turn a shaft", "/tɜːn/", "soustružit hřídel"],
    ["to grind", "/ɡraɪnd/", "brousit"],
    ["surface finish", "/ˈsɜːfɪs ˈfɪnɪʃ/", "kvalita povrchu"],
    ["tool wear", "/tuːl weə/", "opotřebení nástroje"],
    ["cutting speed", "/ˈkʌtɪŋ spiːd/", "řezná rychlost"],
    ["feed rate", "/fiːd reɪt/", "posuvová rychlost"],
    ["chip formation", "/tʃɪp fɔːˈmeɪʃn/", "tvorba třísky"],
    ["coolant", "/ˈkuːlənt/", "chladicí kapalina"],
    ["workpiece", "/ˈwɜːkpiːs/", "obrobek"],
    ["jig", "/dʒɪɡ/", "vrtací nebo montážní přípravek"],
    ["fixture", "/ˈfɪkstʃə/", "upínací přípravek"],
    ["to deburr", "/diːˈbɜː/", "odjehlit"],
    ["burr", "/bɜː/", "otřep"],
    ["die casting", "/daɪ ˈkɑːstɪŋ/", "tlakové lití"],
    ["injection moulding", "/ɪnˈdʒekʃn ˈməʊldɪŋ/", "vstřikování plastů"],
    ["forging", "/ˈfɔːdʒɪŋ/", "kování"],
    ["sheet metal forming", "/ʃiːt ˈmetl ˈfɔːmɪŋ/", "tváření plechu"],
    ["additive manufacturing", "/ˈædɪtɪv/", "aditivní výroba, 3D tisk"],
    ["batch production", "/bætʃ/", "dávková výroba"],
    ["assembly line", "/əˈsembli laɪn/", "montážní linka"],
  ]],
  ["Spojovací materiál a spoje", [
    ["bolt", "/bəʊlt/", "šroub s maticí"],
    ["nut", "/nʌt/", "matice"],
    ["washer", "/ˈwɒʃə/", "podložka"],
    ["screw", "/skruː/", "šroub"],
    ["rivet", "/ˈrɪvɪt/", "nýt"],
    ["torque", "/tɔːk/", "utahovací moment"],
    ["to tighten a bolt", "/ˈtaɪtn/", "utáhnout šroub"],
    ["thread pitch", "/θred pɪtʃ/", "stoupání závitu"],
    ["thread", "/θred/", "závit"],
    ["locknut", "/ˈlɒknʌt/", "pojistná matice"],
    ["preload", "/ˌpriːˈləʊd/", "předpětí"],
    ["shear force", "/ʃɪə fɔːs/", "smykové zatížení"],
    ["weld joint", "/weld dʒɔɪnt/", "svarový spoj"],
    ["welding", "/ˈweldɪŋ/", "svařování"],
    ["brazing", "/ˈbreɪzɪŋ/", "tvrdé pájení"],
    ["soldering", "/ˈsɒldərɪŋ/", "měkké pájení"],
    ["adhesive bonding", "/ədˈhiːsɪv ˈbɒndɪŋ/", "lepené spoje"],
    ["interference fit", "/ˌɪntəˈfɪərəns fɪt/", "přesah, lisovaný spoj"],
    ["keyway", "/ˈkiːweɪ/", "drážka pro pero"],
    ["spline", "/splaɪn/", "drážkování hřídele"],
    ["retaining ring", "/rɪˈteɪnɪŋ rɪŋ/", "pojistný kroužek"],
  ]],
  ["Mechanismy a pohyb", [
    ["gear", "/ɡɪə/", "ozubené kolo"],
    ["gearbox", "/ˈɡɪəbɒks/", "převodovka"],
    ["gear ratio", "/ˈɡɪə ˈreɪʃiəʊ/", "převodový poměr"],
    ["shaft", "/ʃɑːft/", "hřídel"],
    ["bearing", "/ˈbeərɪŋ/", "ložisko"],
    ["ball bearing", "/bɔːl ˈbeərɪŋ/", "kuličkové ložisko"],
    ["roller bearing", "/ˈrəʊlə ˈbeərɪŋ/", "válečkové ložisko"],
    ["coupling", "/ˈkʌplɪŋ/", "spojka"],
    ["clutch", "/klʌtʃ/", "spojka (mechanismus)"],
    ["cam", "/kæm/", "vačka"],
    ["crankshaft", "/ˈkræŋkʃɑːft/", "klikový hřídel"],
    ["piston", "/ˈpɪstən/", "píst"],
    ["flywheel", "/ˈflaɪwiːl/", "setrvačník"],
    ["pulley", "/ˈpʊli/", "kladka"],
    ["belt drive", "/belt draɪv/", "řemenový pohon"],
    ["chain drive", "/tʃeɪn draɪv/", "řetězový pohon"],
    ["linkage", "/ˈlɪŋkɪdʒ/", "kloubový mechanismus"],
    ["lever", "/ˈliːvə/", "páka"],
    ["cog", "/kɒɡ/", "zub ozubeného kola"],
    ["actuator", "/ˈæktʃueɪtə/", "pohon, aktuátor"],
    ["rotational speed", "/rəʊˈteɪʃənl spiːd/", "otáčky, rotační rychlost"],
    ["torque converter", "/tɔːk kənˈvɜːtə/", "měnič točivého momentu"],
    ["backlash", "/ˈbæklæʃ/", "vůle v ozubení"],
    ["gear tooth", "/ɡɪə tuːθ/", "zub ozubeného kola"],
    ["worm gear", "/wɜːm ɡɪə/", "šnekový převod"],
  ]],
  ["Pevnost a namáhání", [
    ["stress", "/stres/", "napětí (v materiálu)"],
    ["strain", "/streɪn/", "deformace"],
    ["load", "/ləʊd/", "zatížení"],
    ["compressive load", "/kəmˈpresɪv/", "tlakové zatížení"],
    ["tensile load", "/ˈtensaɪl/", "tahové zatížení"],
    ["shear stress", "/ʃɪə stres/", "smykové napětí"],
    ["bending moment", "/ˈbendɪŋ ˈməʊmənt/", "ohybový moment"],
    ["deflection", "/dɪˈflekʃn/", "průhyb"],
    ["buckling", "/ˈbʌklɪŋ/", "vzpěr, boulení"],
    ["factor of safety", "/ˈfæktər əv ˈseɪfti/", "součinitel bezpečnosti"],
    ["stress concentration", "/ˌkɒnsənˈtreɪʃn/", "koncentrace napětí"],
    ["fracture", "/ˈfræktʃə/", "lom, prasknutí"],
    ["crack propagation", "/kræk ˌprɒpəˈɡeɪʃn/", "šíření trhliny"],
    ["elastic deformation", "/ɪˈlæstɪk/", "pružná deformace"],
    ["plastic deformation", "/ˈplæstɪk/", "trvalá deformace"],
    ["modulus of elasticity", "/ˈmɒdjʊləs/", "modul pružnosti"],
    ["creep", "/kriːp/", "tečení materiálu"],
    ["residual stress", "/rɪˈzɪdjuəl/", "zbytkové napětí"],
    ["vibration damping", "/vaɪˈbreɪʃn ˈdæmpɪŋ/", "tlumení vibrací"],
    ["resonance", "/ˈrezənəns/", "rezonance"],
    ["static load", "/ˈstætɪk ləʊd/", "statické zatížení"],
    ["dynamic load", "/daɪˈnæmɪk ləʊd/", "dynamické zatížení"],
  ]],
  ["Tolerance a výkresy", [
    ["tolerance", "/ˈtɒlərəns/", "tolerance"],
    ["dimension", "/dɪˈmenʃn/", "rozměr"],
    ["clearance fit", "/ˈklɪərəns fɪt/", "volný spoj"],
    ["technical drawing", "/ˈteknɪkl ˈdrɔːɪŋ/", "technický výkres"],
    ["blueprint", "/ˈbluːprɪnt/", "výkres, projekt"],
    ["datum", "/ˈdeɪtəm/", "vztažná základna"],
    ["surface roughness", "/ˈsɜːfɪs ˈrʌfnəs/", "drsnost povrchu"],
    ["scale drawing", "/skeɪl ˈdrɔːɪŋ/", "výkres v měřítku"],
    ["cross-section", "/krɒs ˈsekʃn/", "průřez"],
    ["orthographic projection", "/ˌɔːθəˈɡræfɪk/", "pravoúhlé promítání"],
    ["isometric view", "/ˌaɪsəˈmetrɪk/", "izometrický pohled"],
    ["assembly drawing", "/əˈsembli ˈdrɔːɪŋ/", "montážní výkres"],
    ["bill of materials", "/bɪl əv məˈtɪəriəlz/", "kusovník"],
    ["revision", "/rɪˈvɪʒn/", "revize (výkresu)"],
    ["geometric dimensioning", "/ˌdʒiːəˈmetrɪk/", "geometrické kótování"],
    ["concentricity", "/ˌkɒnsenˈtrɪsəti/", "souosost"],
    ["flatness", "/ˈflætnəs/", "rovinnost"],
    ["perpendicularity", "/pəˌpendɪkjəˈlærəti/", "kolmost"],
    ["parallelism", "/ˈpærəlelɪzəm/", "rovnoběžnost"],
  ]],
  ["Kvalita a zkoušení", [
    ["quality control", "/ˈkwɒləti kənˈtrəʊl/", "kontrola kvality"],
    ["inspection", "/ɪnˈspekʃn/", "kontrola, inspekce"],
    ["to inspect a part", "/ɪnˈspekt/", "zkontrolovat součást"],
    ["non-destructive testing", "/dɪˈstrʌktɪv/", "nedestruktivní zkoušení"],
    ["calibration", "/ˌkælɪˈbreɪʃn/", "kalibrace"],
    ["gauge", "/ɡeɪdʒ/", "měřidlo"],
    ["caliper", "/ˈkælɪpə/", "posuvné měřítko"],
    ["micrometer", "/maɪˈkrɒmɪtə/", "mikrometr"],
    ["defect", "/ˈdiːfekt/", "vada"],
    ["to fail a test", "/feɪl/", "neprojít zkouškou"],
    ["root cause analysis", "/ruːt kɔːz/", "analýza kořenové příčiny"],
    ["batch testing", "/bætʃ ˈtestɪŋ/", "dávkové testování"],
    ["pressure test", "/ˈpreʃə test/", "tlaková zkouška"],
    ["load test", "/ləʊd test/", "zátěžová zkouška"],
    ["certificate of conformity", "/kənˈfɔːməti/", "certifikát shody"],
    ["traceability", "/ˌtreɪsəˈbɪləti/", "sledovatelnost"],
    ["acceptance criteria", "/əkˈseptəns kraɪˈtɪəriə/", "kritéria přejímky"],
    ["sampling plan", "/ˈsɑːmplɪŋ plæn/", "plán výběru vzorků"],
  ]],
  ["Termodynamika a přenos tepla", [
    ["heat exchanger", "/hiːt ɪksˈtʃeɪndʒə/", "výměník tepla"],
    ["thermal conductivity", "/ˈθɜːml ˌkɒndʌkˈtɪvəti/", "tepelná vodivost"],
    ["convection", "/kənˈvekʃn/", "proudění (přenos tepla)"],
    ["conduction", "/kənˈdʌkʃn/", "vedení tepla"],
    ["radiation", "/ˌreɪdiˈeɪʃn/", "sálání, záření"],
    ["insulation", "/ˌɪnsjʊˈleɪʃn/", "izolace"],
    ["specific heat capacity", "/spəˈsɪfɪk hiːt kəˈpæsəti/", "měrná tepelná kapacita"],
    ["enthalpy", "/ˈenθəlpi/", "entalpie"],
    ["thermal efficiency", "/ˈθɜːml ɪˈfɪʃnsi/", "tepelná účinnost"],
    ["coolant system", "/ˈkuːlənt ˈsɪstəm/", "chladicí systém"],
    ["heat sink", "/hiːt sɪŋk/", "chladič"],
    ["thermodynamic cycle", "/ˌθɜːməʊdaɪˈnæmɪk ˈsaɪkl/", "termodynamický cyklus"],
  ]],
  ["Mechanika tekutin", [
    ["fluid dynamics", "/ˈfluːɪd daɪˈnæmɪks/", "dynamika tekutin"],
    ["viscosity", "/vɪˈskɒsəti/", "viskozita"],
    ["laminar flow", "/ˈlæmɪnə fləʊ/", "laminární proudění"],
    ["turbulent flow", "/ˈtɜːbjələnt fləʊ/", "turbulentní proudění"],
    ["pressure drop", "/ˈpreʃə drɒp/", "tlaková ztráta"],
    ["flow rate", "/fləʊ reɪt/", "průtok"],
    ["pump", "/pʌmp/", "čerpadlo"],
    ["compressor", "/kəmˈpresə/", "kompresor"],
    ["valve", "/vælv/", "ventil"],
    ["nozzle", "/ˈnɒzl/", "tryska"],
    ["cavitation", "/ˌkævɪˈteɪʃn/", "kavitace"],
    ["hydraulic cylinder", "/haɪˈdrɔːlɪk ˈsɪlɪndə/", "hydraulický válec"],
    ["pneumatic system", "/njuˈmætɪk ˈsɪstəm/", "pneumatický systém"],
    ["orifice", "/ˈɒrɪfɪs/", "clona (v potrubí)"],
    ["back pressure", "/bæk ˈpreʃə/", "protitlak"],
  ]],
  ["Design a CAD", [
    ["computer-aided design (CAD)", "/kæd/", "počítačem podporované navrhování"],
    ["prototype", "/ˈprəʊtətaɪp/", "prototyp"],
    ["to design a component", "/dɪˈzaɪn/", "navrhnout součást"],
    ["simulation", "/ˌsɪmjʊˈleɪʃn/", "simulace"],
    ["finite element analysis", "/ˈfaɪnaɪt ˈelɪmənt/", "metoda konečných prvků"],
    ["3D model", "/θriː diː ˈmɒdl/", "3D model"],
    ["assembly model", "/əˈsembli ˈmɒdl/", "sestava, model sestavy"],
    ["design iteration", "/dɪˈzaɪn ˌɪtəˈreɪʃn/", "iterace návrhu"],
    ["to optimise a design", "/ˈɒptɪmaɪz/", "optimalizovat návrh"],
    ["rendering", "/ˈrendərɪŋ/", "vizualizace"],
    ["to reverse-engineer", "/rɪˈvɜːs endʒɪˈnɪə/", "provést zpětné inženýrství"],
    ["digital twin", "/ˈdɪdʒɪtl twɪn/", "digitální dvojče"],
  ]],
  ["Bezpečnost a normy", [
    ["safety standard", "/ˈseɪfti ˈstændəd/", "bezpečnostní norma"],
    ["risk assessment", "/rɪsk əˈsesmənt/", "hodnocení rizik"],
    ["personal protective equipment", "/prəˈtektɪv ɪˈkwɪpmənt/", "osobní ochranné pomůcky"],
    ["hazard", "/ˈhæzəd/", "nebezpečí"],
    ["machine guard", "/məˈʃiːn ɡɑːd/", "kryt stroje"],
    ["lockout-tagout", "/ˈlɒkaʊt ˈtæɡaʊt/", "zajištění stroje proti spuštění"],
    ["compliance", "/kəmˈplaɪəns/", "soulad s předpisy"],
    ["CE marking", "/siː iː ˈmɑːkɪŋ/", "označení CE"],
    ["ISO standard", "/ˈaɪsəʊ ˈstændəd/", "norma ISO"],
    ["emergency stop", "/ɪˈmɜːdʒənsi stɒp/", "nouzové zastavení"],
    ["interlock", "/ˈɪntəlɒk/", "blokovací zařízení"],
    ["to comply with regulations", "/kəmˈplaɪ/", "dodržovat předpisy"],
  ]],
  ["Nástroje a přístroje", [
    ["wrench", "/rentʃ/", "francouzský klíč"],
    ["spanner", "/ˈspænə/", "klíč na matice"],
    ["screwdriver", "/ˈskruːdraɪvə/", "šroubovák"],
    ["pliers", "/ˈplaɪəz/", "kleště"],
    ["hammer", "/ˈhæmə/", "kladivo"],
    ["vice", "/vaɪs/", "svěrák"],
    ["drill press", "/drɪl pres/", "sloupová vrtačka"],
    ["hand tool", "/hænd tuːl/", "ruční nářadí"],
    ["torque wrench", "/tɔːk rentʃ/", "momentový klíč"],
    ["hoist", "/hɔɪst/", "kladkostroj, zvedák"],
    ["crane", "/kreɪn/", "jeřáb"],
    ["forklift", "/ˈfɔːklɪft/", "vysokozdvižný vozík"],
  ]],
  ["Projekt a výroba", [
    ["lead time", "/liːd taɪm/", "dodací lhůta"],
    ["bottleneck", "/ˈbɒtlnek/", "úzké hrdlo (procesu)"],
    ["throughput", "/ˈθruːpʊt/", "propustnost, výkonnost"],
    ["downtime", "/ˈdaʊntaɪm/", "prostoj"],
    ["preventive maintenance", "/prɪˈventɪv ˈmeɪntənəns/", "preventivní údržba"],
    ["predictive maintenance", "/prɪˈdɪktɪv/", "prediktivní údržba"],
    ["spare part", "/speə pɑːt/", "náhradní díl"],
    ["root cause", "/ruːt kɔːz/", "kořenová příčina"],
    ["continuous improvement", "/kənˈtɪnjuəs ɪmˈpruːvmənt/", "neustálé zlepšování"],
    ["lean manufacturing", "/liːn ˌmænjəˈfæktʃərɪŋ/", "štíhlá výroba"],
    ["takt time", "/tækt taɪm/", "takt výroby"],
    ["work order", "/wɜːk ˈɔːdə/", "pracovní příkaz"],
    ["supply chain", "/səˈplaɪ tʃeɪn/", "dodavatelský řetězec"],
    ["procurement", "/prəˈkjʊəmənt/", "nákup, pořizování"],
  ]],
  ["Elektrotechnika pro strojaře", [
    ["motor", "/ˈməʊtə/", "elektromotor"],
    ["sensor", "/ˈsensə/", "senzor, čidlo"],
    ["solenoid", "/ˈsəʊlənɔɪd/", "elektromagnetická cívka, solenoid"],
    ["wiring", "/ˈwaɪərɪŋ/", "elektroinstalace, zapojení"],
    ["circuit breaker", "/ˈsɜːkɪt ˈbreɪkə/", "jistič"],
    ["programmable logic controller (PLC)", "/piː el siː/", "programovatelný logický automat"],
    ["voltage", "/ˈvəʊltɪdʒ/", "napětí"],
    ["current", "/ˈkʌrənt/", "elektrický proud"],
    ["short circuit", "/ʃɔːt ˈsɜːkɪt/", "zkrat"],
    ["earthing / grounding", "/ˈɜːθɪŋ, ˈɡraʊndɪŋ/", "uzemnění"],
    ["frequency converter", "/ˈfriːkwənsi kənˈvɜːtə/", "frekvenční měnič"],
  ]],
  ["Kinematika a dynamika", [
    ["velocity", "/vəˈlɒsəti/", "rychlost (vektorová)"],
    ["acceleration", "/əkˌseləˈreɪʃn/", "zrychlení"],
    ["degrees of freedom", "/dɪˈɡriːz əv ˈfriːdəm/", "stupně volnosti"],
    ["angular velocity", "/ˈæŋɡjələ/", "úhlová rychlost"],
    ["centre of gravity", "/ˈsentər əv ˈɡrævəti/", "těžiště"],
    ["moment of inertia", "/ˈməʊmənt əv ɪˈnɜːʃə/", "moment setrvačnosti"],
    ["kinematic chain", "/ˌkɪnəˈmætɪk tʃeɪn/", "kinematický řetězec"],
    ["trajectory", "/trəˈdʒektəri/", "trajektorie"],
    ["equilibrium", "/ˌiːkwɪˈlɪbriəm/", "rovnováha"],
    ["friction", "/ˈfrɪkʃn/", "tření"],
    ["kinetic energy", "/kɪˈnetɪk ˈenədʒi/", "kinetická energie"],
    ["potential energy", "/pəˈtenʃl ˈenədʒi/", "potenciální energie"],
    ["momentum", "/məˈmentəm/", "hybnost"],
    ["damping", "/ˈdæmpɪŋ/", "tlumení"],
    ["oscillation", "/ˌɒsɪˈleɪʃn/", "kmitání"],
    ["natural frequency", "/ˈnætʃrəl ˈfriːkwənsi/", "vlastní frekvence"],
    ["degrees per second", "/dɪˈɡriːz pə ˈsekənd/", "stupně za sekundu"],
  ]],
  ["Povrchové úpravy", [
    ["coating", "/ˈkəʊtɪŋ/", "povlak, nátěr"],
    ["galvanising", "/ˈɡælvənaɪzɪŋ/", "pozinkování"],
    ["anodising", "/ˈænədaɪzɪŋ/", "eloxování"],
    ["electroplating", "/ɪˈlektrəʊpleɪtɪŋ/", "galvanické pokovování"],
    ["powder coating", "/ˈpaʊdə ˈkəʊtɪŋ/", "práškové lakování"],
    ["sandblasting", "/ˈsændblɑːstɪŋ/", "pískování"],
    ["shot peening", "/ʃɒt ˈpiːnɪŋ/", "kuličkování"],
    ["polishing", "/ˈpɒlɪʃɪŋ/", "leštění"],
    ["passivation", "/ˌpæsɪˈveɪʃn/", "pasivace"],
    ["primer", "/ˈpraɪmə/", "základní nátěr"],
    ["rust", "/rʌst/", "rez"],
    ["pitting corrosion", "/ˈpɪtɪŋ kəˈrəʊʒn/", "bodová koroze"],
    ["surface treatment", "/ˈsɜːfɪs ˈtriːtmənt/", "povrchová úprava"],
    ["wear-resistant coating", "/weə rɪˈzɪstənt/", "otěruvzdorný povlak"],
  ]],
  ["Jednotky a veličiny", [
    ["newton", "/ˈnjuːtən/", "newton (jednotka síly)"],
    ["pascal", "/ˈpæskəl/", "pascal (jednotka tlaku)"],
    ["joule", "/dʒuːl/", "joule (jednotka energie)"],
    ["watt", "/wɒt/", "watt (jednotka výkonu)"],
    ["torque unit (Nm)", "/tɔːk/", "jednotka momentu (Nm)"],
    ["density", "/ˈdensəti/", "hustota"],
    ["mass", "/mæs/", "hmotnost"],
    ["weight", "/weɪt/", "tíha"],
    ["volume", "/ˈvɒljuːm/", "objem"],
    ["displacement", "/dɪsˈpleɪsmənt/", "posunutí, objem (motoru)"],
    ["power output", "/ˈpaʊər ˈaʊtpʊt/", "výkon"],
    ["efficiency", "/ɪˈfɪʃnsi/", "účinnost"],
    ["rpm (revolutions per minute)", "/ɑː piː em/", "otáčky za minutu"],
  ]],
  ["Roboti a automatizace", [
    ["robotic arm", "/rəʊˈbɒtɪk ɑːm/", "robotické rameno"],
    ["automation", "/ˌɔːtəˈmeɪʃn/", "automatizace"],
    ["feedback loop", "/ˈfiːdbæk luːp/", "zpětnovazební smyčka"],
    ["closed-loop control", "/kləʊzd luːp/", "regulace s uzavřenou smyčkou"],
    ["open-loop control", "/ˈəʊpən luːp/", "regulace s otevřenou smyčkou"],
    ["end effector", "/end ɪˈfektə/", "koncový efektor robotu"],
    ["conveyor belt", "/kənˈveɪə belt/", "dopravníkový pás"],
    ["pick and place", "/pɪk ənd pleɪs/", "úkon uchop a polož"],
    ["human-machine interface", "/ˈhjuːmən məˈʃiːn/", "rozhraní člověk-stroj"],
    ["machine vision", "/məˈʃiːn ˈvɪʒn/", "strojové vidění"],
    ["payload capacity", "/ˈpeɪləʊd kəˈpæsəti/", "nosnost"],
  ]],
  ["Výrobní procesy 2", [
    ["extrusion", "/ɪkˈstruːʒn/", "protlačování, extruze"],
    ["stamping", "/ˈstæmpɪŋ/", "lisování plechu"],
    ["sintering", "/ˈsɪntərɪŋ/", "slinování"],
    ["laser cutting", "/ˈleɪzə ˈkʌtɪŋ/", "laserové řezání"],
    ["plasma cutting", "/ˈplæzmə ˈkʌtɪŋ/", "plazmové řezání"],
    ["waterjet cutting", "/ˈwɔːtədʒet/", "řezání vodním paprskem"],
    ["stamping die", "/ˈstæmpɪŋ daɪ/", "lisovací forma"],
    ["mould", "/məʊld/", "forma, kokila"],
    ["draft angle", "/drɑːft ˈæŋɡl/", "úkos formy"],
    ["shrinkage", "/ˈʃrɪŋkɪdʒ/", "smrštění materiálu"],
    ["cycle time", "/ˈsaɪkl taɪm/", "cyklus výroby"],
    ["scrap rate", "/skræp reɪt/", "míra zmetkovitosti"],
  ]],
  ["Nářadí a měření pokročilé", [
    ["dial indicator", "/ˈdaɪəl ˈɪndɪkeɪtə/", "číselníkový úchylkoměr"],
    ["coordinate measuring machine (CMM)", "/kəʊˈɔːdɪnət/", "souřadnicový měřicí stroj"],
    ["thread gauge", "/θred ɡeɪdʒ/", "závitové měřidlo"],
    ["feeler gauge", "/ˈfiːlə ɡeɪdʒ/", "spárová měrka"],
    ["surface plate", "/ˈsɜːfɪs pleɪt/", "rovinná deska"],
    ["protractor", "/prəˈtræktə/", "úhloměr"],
    ["spirit level", "/ˈspɪrɪt ˈlevl/", "vodováha"],
    ["go/no-go gauge", "/ɡəʊ nəʊ ɡəʊ/", "mezní kalibr"],
    ["straightedge", "/ˈstreɪtedʒ/", "pravítko, přímka"],
  ]],
  ["Pružiny, těsnění a tlumení", [
    ["spring", "/sprɪŋ/", "pružina"],
    ["compression spring", "/kəmˈpreʃn sprɪŋ/", "tlačná pružina"],
    ["tension spring", "/ˈtenʃn sprɪŋ/", "tažná pružina"],
    ["spring constant", "/sprɪŋ ˈkɒnstənt/", "tuhost pružiny"],
    ["gasket", "/ˈɡæskɪt/", "těsnění (plošné)"],
    ["O-ring", "/əʊ rɪŋ/", "O-kroužek"],
    ["seal", "/siːl/", "těsnění"],
    ["shock absorber", "/ʃɒk əbˈzɔːbə/", "tlumič nárazů"],
    ["damper", "/ˈdæmpə/", "tlumič"],
    ["rubber mount", "/ˈrʌbə maʊnt/", "pryžové uložení"],
    ["preloaded spring", "/ˌpriːˈləʊdɪd/", "předepnutá pružina"],
    ["leaf spring", "/liːf sprɪŋ/", "listová pružina"],
    ["diaphragm", "/ˈdaɪəfræm/", "membrána"],
  ]],
  ["Potrubí a armatury", [
    ["pipe", "/paɪp/", "trubka, potrubí"],
    ["fitting", "/ˈfɪtɪŋ/", "armatura, spojka"],
    ["flange", "/flændʒ/", "příruba"],
    ["elbow", "/ˈelbəʊ/", "koleno (potrubí)"],
    ["coupling piece", "/ˈkʌplɪŋ piːs/", "spojovací kus"],
    ["hose", "/həʊz/", "hadice"],
    ["manifold", "/ˈmænɪfəʊld/", "rozdělovač, sběrné potrubí"],
    ["gate valve", "/ɡeɪt vælv/", "šoupátko"],
    ["ball valve", "/bɔːl vælv/", "kulový ventil"],
    ["check valve", "/tʃek vælv/", "zpětný ventil"],
    ["pipe thread", "/paɪp θred/", "trubkový závit"],
    ["pressure rating", "/ˈpreʃə ˈreɪtɪŋ/", "tlaková třída"],
    ["leak", "/liːk/", "únik, netěsnost"],
    ["to seal a joint", "/siːl/", "utěsnit spoj"],
  ]],
  ["Konstrukční prvky", [
    ["bracket", "/ˈbrækɪt/", "konzola, držák"],
    ["frame", "/freɪm/", "rám"],
    ["chassis", "/ˈʃæsi/", "podvozek, kostra"],
    ["housing", "/ˈhaʊzɪŋ/", "kryt, plášť"],
    ["enclosure", "/ɪnˈkləʊʒə/", "skříň, kryt"],
    ["panel", "/ˈpænl/", "panel"],
    ["base plate", "/beɪs pleɪt/", "základová deska"],
    ["stiffener", "/ˈstɪfnə/", "výztuha"],
    ["rib", "/rɪb/", "žebro (výztuha)"],
    ["gusset", "/ˈɡʌsɪt/", "výztužný plech"],
    ["mounting hole", "/ˈmaʊntɪŋ həʊl/", "montážní otvor"],
    ["cover plate", "/ˈkʌvə pleɪt/", "krycí deska"],
    ["structural member", "/ˈstrʌktʃərəl ˈmembə/", "nosný prvek konstrukce"],
  ]],
  ["Manipulace s materiálem", [
    ["pallet", "/ˈpælɪt/", "paleta"],
    ["storage rack", "/ˈstɔːrɪdʒ ræk/", "skladovací regál"],
    ["warehouse", "/ˈweəhaʊs/", "sklad"],
    ["overhead crane", "/ˈəʊvəhed kreɪn/", "mostový jeřáb"],
    ["sling", "/slɪŋ/", "vázací popruh"],
    ["to hoist a load", "/hɔɪst/", "zvedat břemeno"],
    ["lifting capacity", "/ˈlɪftɪŋ kəˈpæsəti/", "nosnost zdvihu"],
    ["dolly", "/ˈdɒli/", "přepravní vozík"],
    ["to stack", "/stæk/", "skladovat na sobě, stohovat"],
    ["loading dock", "/ˈləʊdɪŋ dɒk/", "nakládací rampa"],
  ]],
  ["Doplňkové pojmy", [
    ["gearmotor", "/ˈɡɪəməʊtə/", "převodový motor"],
    ["splined shaft", "/splaɪnd ʃɑːft/", "drážkovaný hřídel"],
    ["keyed shaft", "/kiːd ʃɑːft/", "hřídel s perem"],
    ["shim", "/ʃɪm/", "podložka na doladění vůle"],
    ["lubricant", "/ˈluːbrɪkənt/", "mazivo"],
    ["grease", "/ɡriːs/", "tuk (mazivo)"],
    ["to lubricate", "/ˈluːbrɪkeɪt/", "mazat"],
    ["wear and tear", "/weər ənd teə/", "běžné opotřebení"],
    ["service life", "/ˈsɜːvɪs laɪf/", "životnost"],
    ["mean time between failures", "/miːn taɪm/", "střední doba mezi poruchami"],
    ["commissioning", "/kəˈmɪʃənɪŋ/", "uvádění do provozu"],
    ["decommissioning", "/ˌdiːkəˈmɪʃənɪŋ/", "vyřazení z provozu"],
    ["retrofit", "/ˈretrəʊfɪt/", "dodatečná úprava, modernizace"],
    ["as-built drawing", "/æz bɪlt/", "výkres skutečného provedení"],
    ["interchangeability", "/ˌɪntətʃeɪndʒəˈbɪləti/", "zaměnitelnost dílů"],
    ["modular design", "/ˈmɒdjələ dɪˈzaɪn/", "modulární konstrukce"],
    ["obsolescence", "/ˌɒbsəˈlesns/", "zastarávání"],
    ["root mean square", "/ruːt miːn skweə/", "efektivní hodnota (RMS)"],
    ["ergonomics", "/ˌɜːɡəˈnɒmɪks/", "ergonomie"],
    ["payload", "/ˈpeɪləʊd/", "užitečné zatížení"],
    ["prototype testing", "/ˈprəʊtətaɪp ˈtestɪŋ/", "testování prototypu"],
    ["design review", "/dɪˈzaɪn rɪˈvjuː/", "kontrola návrhu"],
    ["failure mode", "/ˈfeɪljə məʊd/", "způsob poruchy"],
    ["root cause corrective action", "/kəˈrektɪv/", "nápravné opatření"],
    ["engineering change order", "/ɪndʒɪˈnɪərɪŋ tʃeɪndʒ/", "příkaz ke změně konstrukce"],
    ["standard operating procedure", "/ˈstændəd ˈɒpəreɪtɪŋ/", "standardní pracovní postup"],
    ["cross-functional team", "/krɒs ˈfʌŋkʃənl/", "mezioborový tým"],
    ["value engineering", "/ˈvæljuː endʒɪˈnɪərɪŋ/", "hodnotové inženýrství"],
    ["obsolete part", "/ˈɒbsəliːt pɑːt/", "vyřazený, zastaralý díl"],
    ["burr removal", "/bɜːr rɪˈmuːvl/", "odjehlení"],
    ["dimensional accuracy", "/daɪˈmenʃənl ˈækjərəsi/", "rozměrová přesnost"],
    ["assembly tolerance stack-up", "/stæk ʌp/", "kumulace tolerancí v sestavě"],
  ]],
];

const CARD_INFO = {"tech:to troubleshoot a fault":{"note":"Systematicky hledat příčinu problému a opravit ho.","example":"We spent two hours troubleshooting the fault before finding a loose connector."},"tech:root cause analysis":{"note":"Metoda zjišťující skutečnou, nejzazší příčinu problému, ne jen příznak.","example":"The root cause analysis showed that the sensor failure was caused by vibration, not by a wiring fault."},"tech:to narrow down the cause":{"note":"Postupně vylučovat možnosti, až zůstane jen nejpravděpodobnější příčina.","example":"By checking each valve in turn, we narrowed down the cause to a sticking actuator."},"tech:to rule out a possibility":{"note":"Vyloučit určitou příčinu jako nepravděpodobnou na základě důkazů.","example":"We can rule out a sensor fault because the reading matches two independent transmitters."},"tech:an intermittent fault":{"note":"Porucha, která se neobjevuje stále, ale jen občas a nepravidelně.","example":"An intermittent fault like this is much harder to diagnose than a permanent one."},"tech:water hammer":{"note":"Náhlý tlakový ráz v potrubí způsobený rychlou změnou rychlosti proudící vody/páry.","example":"Water hammer can seriously damage the piping if the drain valves are not opened slowly."},"tech:water induction":{"note":"Nebezpečný stav, kdy se do turbíny dostane kapalná voda místo páry.","example":"Water induction into the turbine is prevented by proper drainage of the steam lines."},"tech:blade erosion":{"note":"Postupné opotřebení lopatek způsobené kapkami vody nebo pevnými částicemi v páře.","example":"Blade erosion was visible on the last stage, probably caused by wet steam."},"tech:to trip the turbine":{"note":"Automaticky nebo manuálně odstavit turbínu ochranným systémem.","example":"High vibration levels caused the system to trip the turbine automatically."},"tech:a spurious trip":{"note":"Nechtěné odstavení způsobené chybou v měření nebo logice, ne skutečnou poruchou.","example":"After checking the data, we concluded it was a spurious trip caused by a faulty sensor."},"tech:loss of vacuum":{"note":"Pokles vakua v kondenzátoru pod bezpečnou hranici, vážný provozní problém.","example":"Loss of vacuum in the condenser forced an immediate load reduction."},"tech:excessive vibration levels":{"note":"Vibrace převyšující bezpečné provozní limity stroje.","example":"Excessive vibration levels on bearing number 3 triggered an alarm during startup."},"tech:The temperature is drifting up.":{"note":"Teplota se pomalu a plynule zvyšuje, obvykle bez náhlého skoku.","example":"The bearing temperature is drifting up slowly, so we're keeping a close eye on it."},"tech:a faulty transmitter":{"note":"Převodník, který poskytuje nesprávné nebo nespolehlivé měřené hodnoty.","example":"A faulty transmitter was giving a false low-pressure reading."},"tech:to cross-check the readings":{"note":"Porovnat hodnoty z více zdrojů, aby se ověřila jejich správnost.","example":"Always cross-check the readings with a second instrument before shutting the unit down."},"tech:a sticking valve spindle":{"note":"Vřeteno ventilu, které se nepohybuje volně, například vinou koroze nebo nečistot.","example":"A sticking valve spindle prevented the control valve from responding quickly enough."},"tech:leaking gland steam":{"note":"Unikající pára z ucpávek hřídele turbíny.","example":"Leaking gland steam around the coupling end suggests a worn seal."},"tech:to isolate the line":{"note":"Uzavřít armatury a oddělit tak potrubí od zbytku systému.","example":"We need to isolate the line before the technicians can start the repair."},"tech:to drain the condensate":{"note":"Odstranit nahromaděnou kondenzovanou vodu z potrubí nebo zařízení.","example":"Remember to drain the condensate before warming up the steam line."},"tech:a workaround":{"note":"Dočasné, náhradní řešení problému, než se najde trvalá oprava.","example":"As a workaround, we're running the pump manually until the control logic is fixed."},"tech:to restore the unit to service":{"note":"Vrátit zařízení zpět do normálního provozu po odstavení nebo opravě.","example":"Once the inspection is complete, we can restore the unit to service."},"tech:thermal shock":{"note":"Náhlá velká změna teploty, která může způsobit mechanické poškození materiálu.","example":"Rapid cooling of the casing can cause thermal shock and lead to cracking."},"tech:overspeed":{"note":"Stav, kdy otáčky turbíny překročí bezpečný provozní limit.","example":"The emergency governor is designed to prevent overspeed in case of load rejection."},"tech:load rejection":{"note":"Náhlé a neplánované odpojení zátěže (generátoru od sítě).","example":"After the load rejection, the turbine speed briefly rose before the governor stabilised it."},"tech:condition monitoring":{"note":"Nepřetržité sledování stavu zařízení za účelem včasného odhalení poruch.","example":"Condition monitoring data showed a gradual increase in bearing vibration over three months."},"tech:turbogenerator":{"note":"Soustrojí tvořené turbínou a generátorem spojenými na společné hřídeli.","example":"The turbogenerator was shut down for the scheduled annual overhaul."},"tech:turbine casing":{"note":"Vnější plášť turbíny, který udržuje tlak páry a nese vnitřní komponenty.","example":"Cracks were found on the turbine casing during the inspection."},"tech:inner casing":{"note":"Vnitřní plášť u vícepláštových turbín, uvnitř vnějšího tělesa.","example":"The inner casing was removed to inspect the diaphragms."},"tech:shaft":{"note":"Rotující hřídel, na kterém jsou upevněny oběžné lopatky a který přenáší kroutící moment.","example":"The shaft was checked for run-out after the coupling was realigned."},"tech:moving blade":{"note":"Lopatka upevněná na rotoru, která se otáčí a odebírá energii z páry.","example":"Several moving blades on the last stage showed signs of erosion."},"tech:guide blade":{"note":"Nepohybující se lopatka, která usměrňuje proud páry na oběžné lopatky.","example":"The guide blades direct the steam flow onto the next row of moving blades."},"tech:blading":{"note":"Souhrnný termín pro všechny lopatky turbíny (rozváděcí i oběžné).","example":"The new blading was designed to improve efficiency at part load."},"tech:diaphragm":{"note":"Nehybné kolo s rozváděcími lopatkami, které usměrňuje proud páry mezi stupni.","example":"The diaphragm was replaced because of erosion damage on the guide vanes."},"tech:control stage":{"note":"První regulační stupeň turbíny, kde se škrtí vstupující pára.","example":"Most of the pressure drop at part load happens across the control stage."},"tech:labyrinth seal":{"note":"Bezdotykové těsnění tvořené řadou úzkých mezer, snižující únik páry.","example":"The labyrinth seal clearance was checked and adjusted during the overhaul."},"tech:shaft seal / gland":{"note":"Ucpávka zabraňující úniku páry nebo vzduchu podél hřídele.","example":"Steam was escaping from the shaft seal, so we increased the sealing steam pressure."},"tech:balance piston":{"note":"Píst na hřídeli vyrovnávající axiální sílu působící na rotor.","example":"The balance piston helps reduce the axial thrust on the thrust bearing."},"tech:journal bearing":{"note":"Radiální ložisko, které nese váhu hřídele a umožňuje jeho rotaci.","example":"The journal bearing temperature was slightly higher than usual after startup."},"tech:thrust bearing":{"note":"Axiální ložisko, které zachycuje síly působící ve směru osy hřídele.","example":"Excessive axial movement can quickly damage the thrust bearing."},"tech:bearing pedestal":{"note":"Stojan, ve kterém je uloženo ložisko hřídele.","example":"Oil was found leaking from the bearing pedestal during the walk-down inspection."},"tech:coupling":{"note":"Spojka přenášející kroutící moment mezi dvěma hřídelemi.","example":"The coupling was realigned after the generator was reinstalled."},"tech:clearance":{"note":"Mezera nebo vůle mezi dvěma součástmi, například mezi lopatkou a skříní.","example":"The radial clearance between the blade tip and the casing must be checked carefully."},"tech:condensing turbine":{"note":"Turbína, jejíž výstupní pára je vedena do kondenzátoru pod vakuem.","example":"A condensing turbine achieves higher efficiency by expanding steam to a vacuum."},"tech:backpressure turbine":{"note":"Turbína, která vypouští páru při zvýšeném tlaku pro další využití, ne do vakua.","example":"The backpressure turbine supplies exhaust steam to the district heating network."},"tech:extraction turbine":{"note":"Turbína s řízeným odběrem páry z mezistupně pro jiné účely.","example":"An extraction turbine allows steam to be withdrawn at a controlled pressure for process use."},"tech:live steam / main steam":{"note":"Pára přiváděná přímo z kotle do turbíny, ještě před expanzí.","example":"The live steam temperature is monitored continuously at the turbine inlet."},"tech:superheated steam":{"note":"Pára zahřátá nad teplotu sytosti, bez obsahu kapalné vody.","example":"Superheated steam reduces the risk of blade erosion in the early stages."},"tech:saturated steam":{"note":"Pára na hranici kondenzace, při teplotě odpovídající danému tlaku.","example":"Saturated steam condenses immediately if its temperature drops even slightly."},"tech:wet steam":{"note":"Pára obsahující drobné kapky vody, typická pro nízkotlaké stupně.","example":"Wet steam in the low-pressure stages contributes to blade erosion over time."},"tech:exhaust steam":{"note":"Pára vystupující z turbíny po expanzi, směřující do kondenzátoru nebo dál.","example":"The exhaust steam pressure dropped slightly after the condenser cleaning."},"tech:extraction steam":{"note":"Pára odebíraná z turbíny v řízeném množství pro jiné technologické použití.","example":"Extraction steam is used to preheat the feedwater before it returns to the boiler."},"tech:bleed steam":{"note":"Pára odebíraná z turbíny neřízeně, obvykle pro ohřev napájecí vody.","example":"Bleed steam from the second stage feeds the low-pressure feedwater heater."},"tech:gland steam":{"note":"Pára přiváděná do ucpávek hřídele, aby zabránila vniknutí vzduchu nebo úniku páry.","example":"Gland steam pressure must be maintained even when the turbine is on turning gear."},"tech:degree of superheat":{"note":"Rozdíl mezi aktuální teplotou páry a teplotou sytosti při daném tlaku.","example":"A higher degree of superheat helps protect the first stage from moisture damage."},"tech:steam admission":{"note":"Vstup páry do turbíny řízený regulačními ventily.","example":"Steam admission is controlled by the governor valves depending on load demand."},"tech:desuperheating station":{"note":"Zařízení snižující teplotu přehřáté páry vstřikem vody.","example":"The desuperheating station injects water to cool the steam before it enters the process header."},"tech:bypass station":{"note":"Obtoková stanice, která vede páru mimo turbínu, například při odstávce.","example":"The bypass station diverts steam directly to the condenser during startup."},"tech:heat balance diagram":{"note":"Schéma zobrazující toky tepla, páry a energie v celém cyklu.","example":"According to the heat balance diagram, about five percent of the steam is extracted for heating."},"tech:non-return valve (NRV)":{"note":"Ventil, který dovoluje proudění pouze jedním směrem a brání zpětnému toku.","example":"The non-return valve prevents steam from flowing back into the extraction line."},"tech:emergency stop valve (ESV)":{"note":"Ventil, který rychle a úplně uzavře přívod páry při nouzovém odstavení.","example":"The emergency stop valve closed within one second of the trip signal."},"tech:main steam isolation valve":{"note":"Hlavní ventil oddělující turbínu od zdroje páry, například kotle.","example":"The main steam isolation valve was closed before the maintenance crew entered the area."},"tech:control valve":{"note":"Ventil regulující průtok páry podle požadavků regulace zatížení.","example":"The control valve opening increases as the load demand rises."},"tech:safety valve":{"note":"Ventil, který se automaticky otevře při překročení bezpečného tlaku.","example":"The safety valve lifted briefly when the pressure exceeded the set limit."},"tech:rupture disc":{"note":"Bezpečnostní membrána, která se protrhne při nadměrném tlaku, jednorázová ochrana.","example":"A rupture disc was installed upstream of the relief valve as extra protection."},"tech:solenoid valve":{"note":"Ventil ovládaný elektromagnetem, rychle otevírá nebo zavírá podle elektrického signálu.","example":"The solenoid valve de-energised and the actuator moved to its fail-safe position."},"tech:pneumatic actuator":{"note":"Pohon ventilu využívající tlak vzduchu k jeho otevírání nebo zavírání.","example":"The pneumatic actuator lost air supply and the valve closed automatically."},"tech:single-acting actuator":{"note":"Pohon, který je ovládán tlakem vzduchu v jednom směru a vrací se zpět pružinou.","example":"A single-acting actuator returns to its fail-safe position using a spring when air pressure is lost."},"tech:limit switch":{"note":"Koncový spínač signalizující, že ventil dosáhl krajní polohy (otevřeno/zavřeno).","example":"The limit switch confirmed that the valve had fully closed."},"tech:fail-safe position":{"note":"Bezpečná poloha, do které se zařízení přesune automaticky při ztrátě napájení nebo signálu.","example":"The valve's fail-safe position is closed, so it shuts automatically if air supply is lost."},"tech:valve seat":{"note":"Pevná plocha ventilu, na kterou dosedá uzavírací prvek a zajišťuje těsnost.","example":"Erosion on the valve seat was causing the valve to leak slightly when closed."},"tech:valve stroke":{"note":"Vzdálenost, kterou urazí uzavírací prvek ventilu mezi plně otevřenou a zavřenou pozicí.","example":"The full valve stroke takes about three seconds to complete."},"tech:blind flange":{"note":"Plná příruba používaná k uzavření konce potrubí.","example":"A blind flange was fitted to isolate the line during the pressure test."},"tech:double block and bleed":{"note":"Metoda jištění pomocí dvou uzavíracích armatur a odvzdušňovacího/vypouštěcího ventilu mezi nimi pro dokonalé oddělení.","example":"We used a double block and bleed arrangement to safely isolate the section for maintenance."},"tech:valve flutter":{"note":"Nežádoucí rychlé kmitání klapky ventilu, obvykle při nevhodném provozním bodě.","example":"Valve flutter at low flow rates can cause premature wear of the valve seat."},"tech:drainage":{"note":"Systém odvádění nahromaděného kondenzátu z potrubí a zařízení.","example":"Proper drainage of the steam lines prevents water hammer during warm-up."},"tech:condensate":{"note":"Voda vzniklá kondenzací páry.","example":"The condensate is pumped back to the boiler as feedwater."},"tech:flash box / flash tank":{"note":"Nádrž, ve které se z horkého kondenzátu při poklesu tlaku uvolňuje pára (expanduje).","example":"Steam released in the flash tank is reused to preheat makeup water."},"tech:drain pot":{"note":"Sběrná nádoba shromažďující kondenzát z odvodňovacích bodů potrubí.","example":"The drain pot was found full of condensate during the morning inspection."},"tech:steam trap":{"note":"Zařízení, které automaticky odvádí kondenzát, ale zadržuje páru.","example":"A faulty steam trap was allowing live steam to escape continuously."},"tech:orifice":{"note":"Clona s malým otvorem omezující průtok média v potrubí.","example":"An orifice plate was installed to limit the drain flow rate."},"tech:low point":{"note":"Nejnižší místo potrubního úseku, kde se hromadí kondenzát.","example":"Every low point in the steam line must have a drain connection."},"tech:slope / gradient":{"note":"Sklon potrubí, který umožňuje samovolné odtékání kondenzátu.","example":"The pipe must be installed with a slight slope towards the drain point."},"tech:condenser":{"note":"Výměník tepla, ve kterém pára z turbíny kondenzuje na vodu za nízkého tlaku (vakua).","example":"The condenser vacuum dropped slightly after the cooling water inlet was fouled."},"tech:hotwell":{"note":"Sběrná nádrž na dně kondenzátoru, kde se shromažďuje kondenzát před čerpáním zpět do cyklu.","example":"The hotwell level is controlled automatically by the makeup water valve."},"tech:air-cooled condenser (ACC)":{"note":"Kondenzátor chlazený okolním vzduchem pomocí ventilátorů, ne vodou.","example":"The air-cooled condenser performance drops significantly on hot summer days."},"tech:gland steam condenser (GSC)":{"note":"Malý kondenzátor odsávající a kondenzující unikající ucpávkovou páru.","example":"The gland steam condenser maintains a slight vacuum around the shaft seals."},"tech:steam-jet air ejector":{"note":"Zařízení využívající proud páry k odsávání vzduchu a nekondenzujících plynů z kondenzátoru.","example":"The steam-jet air ejector helps maintain vacuum by removing non-condensable gases."},"tech:non-condensable gases":{"note":"Plyny (například vzduch), které nekondenzují s párou a snižují účinnost kondenzátoru.","example":"A build-up of non-condensable gases in the condenser reduces vacuum efficiency."},"tech:tube bundle":{"note":"Svazek trubek v kondenzátoru nebo výměníku tepla, kterými proudí chladicí voda.","example":"The tube bundle was cleaned to remove fouling that reduced heat transfer."},"tech:condensate pump":{"note":"Čerpadlo přečerpávající kondenzát z hotwellu zpět do oběhu.","example":"The standby condensate pump started automatically when the level dropped."},"tech:lube oil system":{"note":"Systém zajišťující tlakové mazání ložisek a dalších komponent turbíny.","example":"The lube oil system pressure must reach the set value before the turbine can be started."},"tech:jacking oil":{"note":"Olej dodávaný pod vysokým tlakem, který nadzdvihne hřídel a vytvoří olejový film při nízkých otáčkách.","example":"Jacking oil is required before the turning gear can be engaged."},"tech:oil mist separator":{"note":"Zařízení odstraňující olejovou mlhu z odvětrávacího vzduchu olejové nádrže.","example":"The oil mist separator prevents oil vapour from escaping into the turbine hall."},"tech:interlock":{"note":"Blokovací podmínka, která zabraňuje nebezpečné nebo nesprávné operaci zařízení.","example":"An interlock prevents the breaker from closing unless the turbine is at rated speed."},"tech:two-out-of-three voting":{"note":"Bezpečnostní logika, kdy je potřeba shoda alespoň dvou ze tří měření k vyvolání akce.","example":"The trip system uses two-out-of-three voting to avoid a spurious trip from a single faulty sensor."},"tech:differential pressure":{"note":"Rozdíl tlaku mezi dvěma místy, často se používá k měření průtoku nebo zanesení filtru.","example":"A high differential pressure across the filter indicates it needs cleaning."},"tech:instrument air":{"note":"Suchý, čistý vzduch pod tlakem používaný k ovládání pneumatických přístrojů a ventilů.","example":"Loss of instrument air caused all pneumatic valves to move to their fail-safe position."},"tech:design pressure":{"note":"Maximální tlak, na který je zařízení navrženo a odolává mu bezpečně.","example":"The casing design pressure includes a safety margin above the normal operating pressure."},"tech:design temperature":{"note":"Maximální teplota, na kterou je zařízení navrženo a odolává jí bezpečně.","example":"Operating above the design temperature can shorten the component's service life significantly."},"tech:nominal diameter (DN)":{"note":"Standardizované jmenovité označení světlosti (vnitřního průměru) potrubí nebo armatury.","example":"The isolation valve has a nominal diameter of DN 200."},"tech:Safety Integrity Level (SIL)":{"note":"Úroveň udávající požadovanou spolehlivost bezpečnostní funkce podle normy.","example":"The trip system was designed to meet a Safety Integrity Level of SIL 2."},"tech:piping and instrumentation diagram":{"note":"Schéma zobrazující potrubí, armatury a měřicí/řídicí přístroje v systému.","example":"Check the piping and instrumentation diagram before isolating the line."},"tech:net positive suction head (NPSH)":{"note":"Minimální přetlak potřebný na sání čerpadla, aby nedošlo ke kavitaci.","example":"If the condensate level drops too low, the pump may not have enough net positive suction head."},"tech:commissioning":{"note":"Proces uvádění zařízení do provozu a ověřování jeho správné funkce.","example":"Commissioning of the new control system is scheduled for next month."},"tech:erection":{"note":"Fyzická strojní montáž zařízení na místě instalace.","example":"Erection of the turbine casing took three weeks longer than planned."},"tech:alignment":{"note":"Přesné vyrovnání os dvou spojovaných komponent, například hřídelí.","example":"Shaft alignment must be rechecked after the coupling bolts are tightened."},"tech:overhaul":{"note":"Rozsáhlá generální oprava zařízení zahrnující demontáž, kontrolu a výměnu dílů.","example":"The turbine is due for a major overhaul after ten years of operation."},"tech:anchor bolt":{"note":"Kotevní šroub pevně spojující základovou konstrukci se zařízením.","example":"All anchor bolts were torqued to the specified value during erection."},"tech:lifting beam":{"note":"Nosník používaný při zdvihání těžkých komponent jeřábem.","example":"A special lifting beam was used to remove the rotor from the casing."},"tech:lay-down area":{"note":"Vyhrazená plocha pro dočasné uložení dílů a zařízení během montáže nebo odstávky.","example":"All spare parts for the overhaul were stored in the designated lay-down area."},"tech:battery limit":{"note":"Smluvně definovaná hranice, kde končí odpovědnost nebo dodávka jedné strany a začíná druhé.","example":"The piping beyond the battery limit is the customer's responsibility."},"tech:scope of supply":{"note":"Rozsah dodávky, tedy co přesně je součástí smluvního plnění.","example":"Installation of the foundation is outside our scope of supply."},"tech:spare parts":{"note":"Náhradní díly uchovávané pro případnou výměnu opotřebených nebo poškozených komponent.","example":"We recommend keeping critical spare parts in stock to minimise downtime."},"tech:lock-out / tag-out (LOTO)":{"note":"Postup zajišťující zařízení proti nechtěnému spuštění během práce na něm, pomocí zámků a cedulek.","example":"Lock-out / tag-out was applied to the breaker before anyone worked near it."},"tech:depressurisation":{"note":"Postupné snižování tlaku v systému na bezpečnou úroveň, obvykle před zásahem.","example":"Depressurisation of the steam line took about twenty minutes before work could start."},"tech:acceptance testing":{"note":"Zkoušky prováděné k ověření, že zařízení splňuje smluvené parametry před předáním.","example":"The unit passed acceptance testing without any issues."},"tech:bearing clearance":{"note":"Vůle mezi hřídelem a ložiskem, nutná pro vytvoření mazacího olejového filmu.","example":"Bearing clearance was measured and found to be within the specified tolerance."},"tech:oil film":{"note":"Tenká vrstva oleje oddělující hřídel od ložiska a zabraňující přímému kontaktu kovu.","example":"A stable oil film prevents metal-to-metal contact between the shaft and the bearing."},"tech:babbitt metal":{"note":"Měkká slitina kovu používaná jako povrchová vrstva ložisek, chránící hřídel.","example":"Scoring was found on the babbitt metal surface of the damaged bearing."},"tech:oil whirl":{"note":"Nestabilní víření olejového filmu v ložisku, které může způsobit vibrace.","example":"Oil whirl was suspected as the cause of the unusual vibration pattern."},"tech:lube oil pressure":{"note":"Tlak mazacího oleje dodávaného do ložisek, musí být nad stanoveným minimem.","example":"Low lube oil pressure triggered an alarm before the standby pump started."},"tech:bearing temperature":{"note":"Teplota ložiska, sledovaná jako indikátor jeho stavu a mazání.","example":"Bearing temperature rose gradually, indicating a possible lubrication problem."},"tech:radial clearance":{"note":"Vůle měřená ve směru příčném k ose hřídele.","example":"Radial clearance in the bearing was slightly below the minimum specified value."},"tech:axial clearance":{"note":"Vůle měřená ve směru podél osy hřídele.","example":"Axial clearance must be checked to prevent contact between rotating and stationary parts."},"tech:oil viscosity grade":{"note":"Klasifikace oleje podle jeho viskozity, určuje vhodnost pro danou aplikaci.","example":"Using the wrong oil viscosity grade can reduce bearing life significantly."},"tech:bearing wear":{"note":"Postupné opotřebení povrchu ložiska v důsledku provozu.","example":"Bearing wear was within acceptable limits after five years of service."},"tech:thrust collar":{"note":"Kroužek na hřídeli, o který se opírá axiální ložisko a přenáší na něj axiální síly.","example":"The thrust collar showed minor scoring and was polished during the overhaul."},"tech:bearing housing":{"note":"Těleso, ve kterém je uloženo samotné ložisko.","example":"Oil was leaking from a seal in the bearing housing."},"tech:lube oil filter":{"note":"Filtr odstraňující nečistoty z mazacího oleje před jeho přivedením k ložiskům.","example":"The lube oil filter differential pressure indicated it was time for a replacement."},"tech:oil degradation":{"note":"Postupné zhoršování vlastností oleje v důsledku stárnutí, oxidace nebo kontaminace.","example":"Oil degradation was confirmed by laboratory analysis of the sample."},"tech:control loop":{"note":"Uzavřený regulační okruh skládající se z čidla, regulátoru a akčního členu.","example":"The control loop was retuned to reduce oscillation at part load."},"tech:setpoint":{"note":"Žádaná (cílová) hodnota regulované veličiny, kterou se regulátor snaží udržet.","example":"The operator changed the pressure setpoint to match the new load demand."},"tech:feedback signal":{"note":"Signál vracející se od čidla zpět do regulátoru, informující o skutečném stavu procesu.","example":"A loss of the feedback signal caused the control loop to go into manual mode."},"tech:PID controller":{"note":"Regulátor používající proporcionální, integrační a derivační složku pro přesné řízení.","example":"The PID controller parameters were adjusted to eliminate the overshoot."},"tech:actuator response time":{"note":"Doba, za kterou pohon reaguje na změnu řídicího signálu a dosáhne požadované polohy.","example":"A slow actuator response time can cause instability in fast control loops."},"tech:analog signal":{"note":"Signál, který se plynule mění v rozsahu hodnot (např. 4–20 mA), na rozdíl od digitálního.","example":"The pressure transmitter sends an analog signal of 4 to 20 milliamps to the controller."},"tech:digital input":{"note":"Binární vstup signalizující pouze dva stavy, zapnuto/vypnuto.","example":"A digital input confirms whether the breaker is open or closed."},"tech:control cabinet":{"note":"Skříň obsahující řídicí a ovládací prvky systému.","example":"All wiring was checked inside the control cabinet before energising the system."},"tech:redundant sensor":{"note":"Záložní čidlo poskytující stejné měření jako hlavní, pro zvýšení spolehlivosti.","example":"A redundant sensor confirmed the reading when the primary transmitter was suspected faulty."},"tech:signal drift":{"note":"Postupná, nežádoucí změna výstupu čidla v čase, i když se měřená veličina nemění.","example":"Signal drift on the temperature transmitter required recalibration."},"tech:override function":{"note":"Funkce umožňující obsluze dočasně ručně přepsat automatické řízení.","example":"The operator used the override function to keep the valve open during the test."},"tech:alarm threshold":{"note":"Prahová hodnota, při jejímž překročení se spustí alarm.","example":"The alarm threshold for bearing temperature was set to 90 degrees Celsius."},"tech:man-machine interface":{"note":"Rozhraní (obrazovka, ovládací panel), přes které obsluha komunikuje s řídicím systémem.","example":"The new man-machine interface makes it easier to spot abnormal trends."},"tech:fail-to-safe logic":{"note":"Logika zajišťující, že při poruše systém přejde do bezpečného stavu.","example":"Fail-to-safe logic ensures the valve closes if the control signal is lost."},"tech:generator stator":{"note":"Nepohybující se část generátoru obsahující vinutí, ve kterém se indukuje napětí.","example":"Insulation resistance of the generator stator winding was tested before startup."},"tech:generator rotor":{"note":"Otáčející se část generátoru, obvykle nesoucí budicí vinutí.","example":"The generator rotor was removed for inspection of the winding."},"tech:excitation system":{"note":"Systém zajišťující budicí proud pro vytvoření magnetického pole v rotoru generátoru.","example":"A fault in the excitation system caused the generator voltage to drop."},"tech:stator winding":{"note":"Vodivé vinutí umístěné ve statoru, ve kterém se generuje elektrické napětí.","example":"Partial discharge testing was performed on the stator winding."},"tech:air gap":{"note":"Vzduchová mezera mezi rotorem a statorem generátoru, ovlivňující jeho vlastnosti.","example":"The air gap was measured at several points around the generator."},"tech:synchronisation":{"note":"Proces přizpůsobení frekvence, napětí a fáze generátoru před jeho připojením k síti.","example":"Synchronisation with the grid was completed within the expected time window."},"tech:power factor":{"note":"Poměr činného a zdánlivého výkonu, vyjadřuje efektivitu využití elektrické energie.","example":"The grid operator requested the plant to operate at a power factor of 0.95."},"tech:generator terminal":{"note":"Svorka, na kterou je připojen výstupní kabel generátoru.","example":"Voltage was measured directly at the generator terminal."},"tech:stray flux":{"note":"Magnetický tok, který unikne mimo zamýšlenou dráhu a může způsobit ztráty nebo zahřívání.","example":"Stray flux losses contribute to additional heating in nearby metal components."},"tech:insulation resistance":{"note":"Odpor izolace vodičů, nízká hodnota může signalizovat poškození nebo vlhkost.","example":"Insulation resistance was measured before the generator was put back into service."},"tech:busbar":{"note":"Vodivá tyč nebo lišta rozvádějící elektrický proud mezi zařízeními v rozvodně.","example":"The busbar connections were checked for signs of overheating."},"tech:transformer":{"note":"Zařízení měnící úroveň napětí elektrického proudu při zachování frekvence.","example":"The generator transformer steps up the voltage before it enters the grid."},"tech:cooling gas (hydrogen)":{"note":"Plyn, nejčastěji vodík, používaný k chlazení velkých generátorů díky dobré tepelné vodivosti.","example":"Hydrogen purity inside the generator casing is monitored continuously as a cooling gas."},"tech:trip logic":{"note":"Logické obvody a podmínky, které rozhodují o odstavení zařízení z bezpečnostních důvodů.","example":"The trip logic was tested during the planned outage to confirm correct operation."},"tech:redundant trip channel":{"note":"Nezávislý, záložní kanál odstavovacího systému zvyšující spolehlivost ochrany.","example":"Each redundant trip channel can independently initiate a turbine trip."},"tech:safety instrumented system":{"note":"Komplexní systém čidel, logiky a akčních členů navržený k udržení bezpečného stavu zařízení.","example":"The safety instrumented system automatically closed the main steam valve during the test."},"tech:common cause failure":{"note":"Porucha postihující více redundantních prvků najednou ze stejné příčiny, snižující přínos redundance.","example":"A common cause failure, such as a power supply fault, could defeat the redundant sensors."},"tech:proof test":{"note":"Periodická zkouška ověřující, že bezpečnostní funkce stále funguje správně.","example":"A proof test of the emergency stop valve is carried out once a year."},"tech:fail-safe design":{"note":"Návrh zajišťující, že zařízení při poruše přejde do bezpečného stavu.","example":"The fail-safe design ensures the valve closes automatically if power is lost."},"tech:trip and throttle valve":{"note":"Kombinovaný ventil sloužící jak k rychlému uzavření (odstavení), tak k regulaci průtoku páry.","example":"The trip and throttle valve closed immediately after the trip signal was received."},"tech:emergency governor":{"note":"Nezávislý nouzový regulátor otáček, který zasáhne při selhání hlavního regulačního systému.","example":"The emergency governor is set to trip the turbine at a slightly higher speed than the main overspeed protection."},"tech:overspeed test":{"note":"Zkouška, při které se turbína záměrně roztočí nad jmenovité otáčky k ověření funkce ochrany.","example":"An overspeed test confirmed that the trip activates at the correct speed."},"tech:hazard and operability study":{"note":"Systematická metoda (HAZOP) identifikující rizika a provozní problémy v návrhu procesu.","example":"A hazard and operability study identified a potential overpressure scenario in the drain system."},"tech:vibration probe":{"note":"Sonda měřící vibrace hřídele nebo skříně, obvykle bezdotykově.","example":"The vibration probe showed a sudden increase in amplitude during startup."},"tech:shaft orbit":{"note":"Grafické zobrazení dráhy, kterou opisuje osa hřídele během rotace.","example":"The shaft orbit plot revealed an elliptical pattern typical of misalignment."},"tech:spectral analysis":{"note":"Rozklad vibračního signálu na jednotlivé frekvenční složky za účelem diagnostiky.","example":"Spectral analysis identified a peak at twice the running speed, suggesting misalignment."},"tech:phase angle":{"note":"Úhlový posun mezi referenčním signálem a maximem vibrace, používaný při diagnostice vyvážení.","example":"The phase angle measurement helped locate the heavy spot on the rotor."},"tech:unbalance":{"note":"Nerovnoměrné rozložení hmoty na rotoru způsobující vibrace při otáčení.","example":"Rotor unbalance was corrected by adding a small weight at the specified location."},"tech:misalignment":{"note":"Nesprávné vzájemné vyrovnání os dvou spojených hřídelí.","example":"Misalignment between the turbine and generator shafts caused excessive coupling vibration."},"tech:critical speed":{"note":"Otáčky, při kterých dochází k rezonanci rotoru s jeho vlastní frekvencí.","example":"The turbine must pass through its critical speed quickly during startup to avoid high vibration."},"tech:run-out":{"note":"Odchylka povrchu rotující součásti od ideálního kruhu, měřená jako házivost.","example":"Shaft run-out was measured before the final coupling alignment."},"tech:baseline reading":{"note":"Výchozí naměřená hodnota sloužící jako referenční bod pro budoucí srovnání.","example":"The baseline reading was recorded immediately after commissioning for future comparison."},"tech:trend monitoring":{"note":"Sledování vývoje naměřených hodnot v čase k odhalení postupně se zhoršujícího stavu.","example":"Trend monitoring showed a slow but steady rise in vibration over several weeks."},"tech:proximity probe":{"note":"Bezdotyková sonda měřící vzdálenost nebo pohyb hřídele vůči ložisku.","example":"The proximity probe detected an increase in radial shaft movement."},"tech:keyphasor":{"note":"Referenční čidlo snímající jednu značku na hřídeli za otáčku, pro fázová a otáčková měření.","example":"The keyphasor signal is used as a reference to calculate the phase angle of vibration."},"tech:weld inspection":{"note":"Kontrola kvality a bezvadnosti svarového spoje.","example":"Weld inspection revealed a small crack near the root of the joint."},"tech:heat-affected zone":{"note":"Oblast materiálu v okolí svaru, jejíž struktura byla ovlivněna teplem při svařování.","example":"The heat-affected zone was checked for hardness to confirm it met the specification."},"tech:post-weld heat treatment":{"note":"Tepelné zpracování svaru po jeho dokončení, snižující vnitřní pnutí.","example":"Post-weld heat treatment was required due to the thickness of the material."},"tech:weld procedure specification":{"note":"Dokument popisující přesný postup a parametry pro provedení konkrétního svaru.","example":"The welder followed the approved weld procedure specification for this joint type."},"tech:filler material":{"note":"Přídavný materiál (drát, elektroda) dodávaný do svarové lázně při svařování.","example":"The filler material must match the base metal composition closely."},"tech:preheat temperature":{"note":"Teplota, na kterou se materiál předehřívá před svařováním, aby se předešlo trhlinám.","example":"The preheat temperature was checked with a surface thermometer before welding began."},"tech:weld defect":{"note":"Vada ve svarovém spoji, například trhlina, pór nebo neprovařené místo.","example":"A weld defect was found during the ultrasonic testing and had to be repaired."},"tech:radiographic testing":{"note":"Nedestruktivní zkouška svaru pomocí rentgenového nebo gama záření.","example":"Radiographic testing confirmed there were no internal defects in the weld."},"tech:ultrasonic testing":{"note":"Nedestruktivní zkouška využívající ultrazvukové vlny k odhalení vnitřních vad materiálu.","example":"Ultrasonic testing is often preferred on site because it requires no radiation safety zone."},"tech:dye penetrant test":{"note":"Nedestruktivní zkouška odhalující povrchové trhliny pomocí barevné penetrační kapaliny.","example":"A dye penetrant test revealed a fine surface crack near the weld toe."},"tech:magnetic particle test":{"note":"Nedestruktivní zkouška odhalující povrchové i podpovrchové vady pomocí magnetického pole a prášku.","example":"The magnetic particle test is suitable only for ferromagnetic materials."},"tech:material certificate":{"note":"Dokument potvrzující původ, složení a vlastnosti dodaného materiálu.","example":"The material certificate confirmed the steel grade matched the specification."},"tech:as-found condition":{"note":"Popis skutečného stavu zařízení v okamžiku zahájení kontroly, před jakýmkoliv zásahem.","example":"The as-found condition of the bearing showed only minor wear."},"tech:as-left condition":{"note":"Popis stavu zařízení po dokončení práce, před opětovným spuštěním.","example":"The as-left condition was documented with photographs before the casing was closed."},"tech:inspection report":{"note":"Dokument shrnující zjištění a výsledky provedené kontroly.","example":"The inspection report recommended replacing two of the bearings."},"tech:outage scope":{"note":"Souhrn všech plánovaných prací, které se mají provést během odstávky.","example":"The outage scope was extended after cracks were found on the rotor."},"tech:work permit":{"note":"Formální písemné povolení k provedení konkrétní práce, obvykle s bezpečnostními podmínkami.","example":"No one may enter the vessel without a valid work permit."},"tech:technical specification":{"note":"Dokument popisující požadované technické parametry zařízení nebo dodávky.","example":"The replacement valve must meet the original technical specification."},"tech:deviation report":{"note":"Dokument hlásící odchylku od schváleného postupu, návrhu nebo specifikace.","example":"A deviation report was filed when the measured clearance was outside the tolerance."},"tech:field modification":{"note":"Úprava provedená přímo na místě instalace, odlišná od původního návrhu.","example":"A field modification was needed to route the new cable away from the hot pipe."},"tech:service bulletin":{"note":"Dokument vydaný výrobcem s doporučením nebo informací týkající se provozu či údržby zařízení.","example":"The service bulletin recommended an additional inspection interval for this bearing type."},"tech:root cause report":{"note":"Formální dokument popisující výsledky analýzy kořenové příčiny poruchy.","example":"The root cause report concluded that the failure was due to inadequate lubrication."},"tech:non-conformance report":{"note":"Dokument hlásící, že výrobek nebo práce neodpovídá stanoveným požadavkům.","example":"A non-conformance report was raised after the weld failed the ultrasonic test."},"tech:to isolate a fault":{"note":"Omezit nebo oddělit problém na konkrétní část systému, aby se zjednodušila diagnostika.","example":"We managed to isolate the fault to a single faulty relay in the control cabinet."},"tech:to bypass a signal temporarily":{"note":"Dočasně obejít jeden signál nebo podmínku, obvykle za účelem testování nebo nouzového provozu.","example":"We had to bypass the signal temporarily to allow the pump to start during the test."},"tech:to simulate a trip":{"note":"Vyvolat testovací odstavení za kontrolovaných podmínek k ověření funkce systému.","example":"We simulated a trip to confirm that all the valves closed correctly."},"tech:to reproduce a fault":{"note":"Záměrně vyvolat stejné podmínky, za kterých se porucha objevila, aby šla lépe prozkoumat.","example":"The team struggled to reproduce the fault in the workshop under normal conditions."},"tech:to escalate an issue":{"note":"Postoupit problém na vyšší úroveň odpovědnosti nebo odbornosti, pokud ho nelze vyřešit na stávající úrovni.","example":"We decided to escalate the issue to the design engineering team."},"tech:to log an event":{"note":"Zaznamenat událost (např. alarm nebo akci) s časovým údajem pro pozdější analýzu.","example":"The control system automatically logs an event every time an alarm is triggered."},"tech:event sequence recorder":{"note":"Zařízení zaznamenávající přesný časový sled jednotlivých událostí a alarmů.","example":"The event sequence recorder showed that the high vibration alarm occurred before the trip."},"tech:to pinpoint the cause":{"note":"Přesně určit konkrétní příčinu problému, bez pochybností.","example":"The data from the recorder helped us pinpoint the cause of the trip within minutes."},"tech:interim fix":{"note":"Dočasné řešení umožňující provoz do doby, než bude provedena trvalá oprava.","example":"An interim fix was applied to keep the unit running until the spare part arrives."},"tech:to verify a repair":{"note":"Ověřit, že provedená oprava skutečně vyřešila původní problém.","example":"We ran the pump for several hours to verify the repair before closing the work order."},"tech:recurring fault":{"note":"Porucha, která se opakovaně vrací i po předchozí opravě.","example":"This is a recurring fault; it's the third time this sensor has failed this year."},"tech:corrective action plan":{"note":"Plán konkrétních kroků navržených k odstranění příčiny problému a zabránění jeho opakování.","example":"The corrective action plan includes replacing the sensor and improving the maintenance schedule."},"tech:permanent fix":{"note":"Trvalé, definitivní řešení problému, na rozdíl od dočasného provizorního opatření.","example":"The permanent fix will be implemented during the next planned outage."},"tech:troubleshooting checklist":{"note":"Strukturovaný seznam kroků usnadňující systematickou diagnostiku poruchy.","example":"Following the troubleshooting checklist helped us find the fault much faster."},"cust:to reach an agreement":{"note":"Dojít ke shodě obou stran po jednání.","example":"After a long discussion, both sides finally reached an agreement on the delivery date."},"cust:to find common ground":{"note":"Najít body, na kterých se obě strany shodnou, i při odlišných zájmech.","example":"Let's try to find common ground before we discuss the price."},"cust:to meet halfway":{"note":"Udělat kompromis, kdy obě strany trochu ustoupí ze svého požadavku.","example":"If you lower the price slightly, we could meet halfway on the delivery schedule."},"cust:a deal-breaker":{"note":"Podmínka nebo problém, který způsobí, že dohoda nebude uzavřena.","example":"A shorter warranty period would be a deal-breaker for us."},"cust:That is non-negotiable.":{"note":"Používá se pro podmínku, o které firma odmítá dále jednat.","example":"The safety inspection schedule is non-negotiable, I'm afraid."},"cust:That's not something we can commit to.":{"note":"Zdvořilé odmítnutí závazku k něčemu, co není jisté nebo možné.","example":"A fixed price for three years is not something we can commit to right now."},"cust:Let me come back to you on that.":{"note":"Zdvořilý způsob, jak odložit odpověď a ozvat se později.","example":"I need to check the numbers, so let me come back to you on that tomorrow."},"cust:That's outside my authority.":{"note":"Sdělení, že daný požadavek nemůže mluvčí sám schválit.","example":"Approving a discount that large is outside my authority."},"cust:I'd have to check with my manager.":{"note":"Používá se, když je potřeba schválení od nadřízeného.","example":"I'd have to check with my manager before confirming that date."},"cust:to push back on a request":{"note":"Nesouhlasit s požadavkem a vyjádřit svůj nesouhlas nebo protinávrh.","example":"We decided to push back on the request for an earlier delivery date."},"cust:Where's the main sticking point?":{"note":"Otázka na to, co konkrétně brání dohodě.","example":"Where's the main sticking point - is it the price or the schedule?"},"cust:Would you be open to …?":{"note":"Zdvořilý způsob, jak navrhnout alternativu a zjistit ochotu druhé strany.","example":"Would you be open to extending the deadline by two weeks?"},"cust:If we do X, could you do Y?":{"note":"Struktura vyjednávací výměny - nabídka ústupku podmíněná protihodnotou.","example":"If we extend the warranty, could you commit to the original schedule?"},"cust:I hear you, but …":{"note":"Fráze uznávající názor druhé strany před vyjádřením nesouhlasu.","example":"I hear you, but the budget simply doesn't allow for that right now."},"cust:With all due respect, …":{"note":"Zdvořilý, ale pevný úvod k vyjádření nesouhlasu.","example":"With all due respect, I think the timeline you're suggesting is unrealistic."},"cust:Let's park that for now.":{"note":"Navrhnout odložení tématu na později, aby jednání mohlo pokračovat.","example":"Let's park that for now and come back to it after lunch."},"cust:to bring it up at the next meeting":{"note":"Naplánovat, že se o tématu bude jednat na příští schůzce.","example":"We can bring it up at the next meeting once we have more data."},"cust:a goodwill gesture":{"note":"Nevynucený krok nabídnutý na podporu dobrých vztahů, ne z povinnosti.","example":"As a goodwill gesture, we extended the warranty by three months."},"cust:It's still under warranty.":{"note":"Používá se k potvrzení, že se na zařízení stále vztahuje záruka.","example":"The bearing failure is covered because the unit is still under warranty."},"cust:liquidated damages":{"note":"Smluvní pokuta za nedodržení podmínek, předem stanovená ve smlouvě.","example":"Liquidated damages apply if the delivery is more than two weeks late."},"cust:to renegotiate the deadline":{"note":"Znovu projednat a případně změnit dohodnutý termín.","example":"Due to the supply delay, we need to renegotiate the deadline."},"cust:That would set a precedent.":{"note":"Varování, že souhlas v jednom případě by vytvořil očekávání i pro budoucí případy.","example":"If we waive the fee this time, that would set a precedent for future orders."},"cust:on the understanding that …":{"note":"Fráze vyjadřující podmínku, za které platí dohoda.","example":"We'll proceed on the understanding that the final price will be confirmed in writing."},"cust:Let's put that in writing.":{"note":"Žádost o písemné potvrzení ústní dohody.","example":"That sounds good - let's put that in writing before we finish today."},"cust:Let me walk you through it.":{"note":"Nabídka podrobně a postupně vysvětlit nějaký proces nebo dokument.","example":"Let me walk you through the inspection findings step by step."},"cust:Based on the trend data, …":{"note":"Úvod ke závěru odvozenému z dlouhodobě sledovaných hodnot.","example":"Based on the trend data, the vibration has been increasing steadily for a month."},"cust:The evidence points to …":{"note":"Vyjadřuje, že dostupné důkazy nasvědčují určitému závěru.","example":"The evidence points to a lubrication issue rather than a mechanical defect."},"cust:We can't rule that out yet.":{"note":"Sdělení, že určitá možnost stále nebyla vyloučena.","example":"We can't rule that out yet - we still need the lab results."},"cust:I'd rather not speculate.":{"note":"Zdvořilé odmítnutí odhadovat bez dostatečných údajů.","example":"I'd rather not speculate until we've reviewed all the data."},"cust:My best guess at this stage is …":{"note":"Opatrné vyjádření předběžného odhadu, s vědomím nejistoty.","example":"My best guess at this stage is a faulty transmitter, but we'll confirm it tomorrow."},"cust:to keep you in the loop":{"note":"Pravidelně informovat druhou stranu o vývoji situace.","example":"I'll keep you in the loop as soon as we have more information."},"cust:to give you a quick update":{"note":"Stručně informovat o aktuálním stavu věci.","example":"Let me give you a quick update on where we are with the repair."},"cust:as a precautionary measure":{"note":"Opatření učiněné pro jistotu, i když riziko není potvrzené.","example":"We reduced the load as a precautionary measure until the cause is confirmed."},"cust:It's a temporary fix.":{"note":"Upozornění, že řešení je dočasné a bude nahrazeno trvalým.","example":"It's a temporary fix - we'll install the new part during the next outage."},"cust:We'll have to take the unit offline.":{"note":"Oznámení, že zařízení musí být odstaveno z provozu.","example":"We'll have to take the unit offline to replace the faulty sensor."},"cust:This is within our scope of supply.":{"note":"Potvrzení, že daná práce nebo položka je součástí smluvené dodávky.","example":"Replacing the valve is within our scope of supply, so there's no extra charge."},"cust:That falls outside our scope.":{"note":"Sdělení, že daná položka není součástí smluvené dodávky.","example":"I'm afraid the pump upgrade falls outside our scope."},"cust:to raise a concern":{"note":"Upozornit na problém nebo obavu, kterou je potřeba řešit.","example":"I'd like to raise a concern about the current inspection interval."},"cust:I'd like to flag a potential risk.":{"note":"Upozornění na možné riziko dříve, než se stane problémem.","example":"I'd like to flag a potential risk with the current cooling water quality."},"cust:to sign off on the report":{"note":"Formálně schválit a potvrdit dokument svým podpisem nebo souhlasem.","example":"The site manager needs to sign off on the report before we close the job."},"cust:lessons learned":{"note":"Poznatky a zkušenosti získané z realizovaného projektu nebo události, využitelné do budoucna.","example":"We documented the lessons learned so the next outage goes more smoothly."},"cust:to follow up on something":{"note":"Vrátit se k dříve zmíněné věci a dotáhnout ji do konce.","example":"I'll follow up on the spare parts order next week."},"cust:Correct me if I'm wrong, but …":{"note":"Zdvořilý úvod k vyjádření svého chápání situace, s otevřeností k opravě.","example":"Correct me if I'm wrong, but I thought the inspection was scheduled for Monday."},"cust:Let me make sure I've got this right.":{"note":"Ověření, že mluvčí správně pochopil to, co bylo řečeno.","example":"Let me make sure I've got this right - you want the report by Friday?"},"cust:Could you talk me through the alarms?":{"note":"Žádost o podrobné vysvětlení jednotlivých alarmů a jejich významu.","example":"Could you talk me through the alarms that triggered before the trip?"},"cust:to put it in plain terms":{"note":"Vysvětlit něco jednoduše, bez technického žargonu.","example":"To put it in plain terms, the bearing is simply worn out."},"cust:unplanned downtime":{"note":"Neplánovaná odstávka zařízení, obvykle způsobená poruchou.","example":"Unplanned downtime cost the plant several hours of lost production."},"cust:plant availability":{"note":"Procento času, kdy je zařízení schopné provozu, ukazatel spolehlivosti.","example":"Plant availability improved significantly after the new maintenance programme."},"cust:I'll drop it in the chat.":{"note":"Nabídka poslat informaci nebo odkaz do textového chatu během hovoru.","example":"I'll drop it in the chat so everyone has the link."},"cust:Sorry, you cut out for a second.":{"note":"Upozornění, že spojení na chvíli vypadlo a mluvčí neslyšel celou větu.","example":"Sorry, you cut out for a second - could you repeat the last point?"},"cust:Could I just jump in here?":{"note":"Zdvořilá žádost o možnost vstoupit do hovoru a něco doplnit.","example":"Could I just jump in here? I think that figure needs updating."},"cust:Let's take this offline.":{"note":"Návrh probrat konkrétní téma mimo hlavní schůzku, obvykle jen s menší skupinou.","example":"That's a detailed technical issue - let's take this offline after the call."},"cust:Can everyone see my screen?":{"note":"Otázka ověřující, zda je sdílená obrazovka při online hovoru viditelná pro všechny.","example":"Can everyone see my screen? I'd like to show you the latest drawing."},"cust:Just to recap, …":{"note":"Úvod ke stručnému shrnutí toho, co již bylo probráno.","example":"Just to recap, we agreed on the new delivery date of the fifteenth."},"cust:What are the next steps?":{"note":"Otázka na konkrétní kroky, které budou následovat po schůzce.","example":"What are the next steps before we can finalise the order?"},"cust:to set up a follow-up meeting":{"note":"Domluvit další schůzku navazující na aktuální jednání.","example":"Let's set up a follow-up meeting once we have the test results."},"cust:I'll send over the minutes.":{"note":"Slib poslat zápis z jednání ostatním účastníkům.","example":"I'll send over the minutes by the end of the day."},"cust:Let's wrap up the call.":{"note":"Návrh na ukončení hovoru nebo schůzky.","example":"I think we've covered everything - let's wrap up the call."},"cust:I am writing to inform you that...":{"note":"Formální úvodní fráze e-mailu oznamující nějakou informaci.","example":"I am writing to inform you that the delivery has been delayed by one week."},"cust:Please find attached...":{"note":"Formální fráze upozorňující na přílohu e-mailu.","example":"Please find attached the updated inspection report."},"cust:I would like to follow up on...":{"note":"Formální fráze navazující na dřívější komunikaci nebo žádost.","example":"I would like to follow up on my previous email regarding the spare parts."},"cust:Thank you for your prompt reply.":{"note":"Poděkování za rychlou odpověď, běžné v obchodní korespondenci.","example":"Thank you for your prompt reply - we can proceed as planned."},"cust:I look forward to hearing from you.":{"note":"Zdvořilá závěrečná fráze vyjadřující očekávání odpovědi.","example":"I look forward to hearing from you by the end of the week."},"cust:Please do not hesitate to contact me.":{"note":"Zdvořilá nabídka dalšího kontaktu v případě dotazů.","example":"Please do not hesitate to contact me if you have any further questions."},"cust:Apologies for the delayed response.":{"note":"Formální omluva za pomalejší odpověď na zprávu.","example":"Apologies for the delayed response - I was out of the office last week."},"cust:Could you please clarify...?":{"note":"Zdvořilá žádost o upřesnění nejasné informace.","example":"Could you please clarify what you mean by 'extended scope'?"},"cust:I am forwarding this email to...":{"note":"Formální fráze oznamující přeposlání e-mailu další osobě.","example":"I am forwarding this email to our technical department for review."},"cust:cc'd on this email":{"note":"Vyjadřuje, že daná osoba je uvedena v kopii e-mailu.","example":"I've cc'd our project manager on this email for visibility."},"cust:to loop someone in":{"note":"Přizvat někoho do konverzace nebo komunikačního vlákna.","example":"Let's loop in the site engineer so he's aware of the change."},"cust:as per our conversation":{"note":"Odkaz na dříve dohodnuté body z osobního nebo telefonického rozhovoru.","example":"As per our conversation, I'm sending the revised schedule attached."},"cust:kind regards":{"note":"Běžné formální zakončení obchodního e-mailu, ekvivalent 'S pozdravem'.","example":"Thank you for your understanding. Kind regards, Štěpán."},"cust:Let me give you a brief overview.":{"note":"Nabídka stručně uvést hlavní body tématu na začátku prezentace.","example":"Let me give you a brief overview of today's agenda."},"cust:Moving on to the next slide...":{"note":"Fráze signalizující přechod na další část prezentace.","example":"Moving on to the next slide, you can see the performance comparison."},"cust:To summarise the key points...":{"note":"Úvod ke shrnutí hlavních bodů prezentace nebo diskuse.","example":"To summarise the key points, availability improved and costs went down."},"cust:Are there any questions so far?":{"note":"Otázka zjišťující, zda má publikum dotazy k dosavadnímu obsahu.","example":"Are there any questions so far before I move on to the next section?"},"cust:I'll hand over to my colleague.":{"note":"Předání slova dalšímu členovi týmu během prezentace nebo jednání.","example":"I'll hand over to my colleague, who will cover the technical details."},"cust:Let's dive into the details.":{"note":"Výzva k přechodu z obecného přehledu k podrobnému vysvětlení.","example":"Now let's dive into the details of the maintenance plan."},"cust:This chart illustrates...":{"note":"Fráze uvádějící, co konkrétní graf ukazuje.","example":"This chart illustrates the trend in vibration levels over the past year."},"cust:As you can see on the screen...":{"note":"Odkaz na obsah zobrazený na promítané obrazovce.","example":"As you can see on the screen, efficiency peaked during the summer months."},"cust:To put it simply...":{"note":"Úvod k jednoduchému, nekomplikovanému vysvětlení.","example":"To put it simply, the bearing needs replacing sooner than planned."},"cust:I'll come back to that point later.":{"note":"Oznámení, že se mluvčí k danému bodu vrátí později v prezentaci.","example":"That's a good question - I'll come back to that point later in the presentation."},"cust:hands-on training":{"note":"Praktické školení, při kterém si účastníci sami zkouší úkony na zařízení.","example":"The hands-on training included a full valve maintenance exercise."},"cust:training material":{"note":"Podkladové materiály (manuály, prezentace) používané při školení.","example":"All training material was translated into the local language."},"cust:to submit a quote":{"note":"Předložit zákazníkovi cenovou nabídku na zboží nebo službu.","example":"We submitted a quote for the bearing replacement last week."},"cust:to be within budget":{"note":"Vejít se do stanoveného finančního rámce.","example":"The proposed solution is well within budget."},"cust:payment terms":{"note":"Podmínky stanovující, kdy a jak má být platba uhrazena.","example":"Our standard payment terms are thirty days from invoice date."},"cust:to offer a discount":{"note":"Nabídnout zákazníkovi snížení ceny.","example":"We can offer a discount if you order more than ten units."},"cust:lead time on delivery":{"note":"Doba od objednání po dodání zboží nebo služby.","example":"The lead time on delivery for this part is currently eight weeks."},"cust:to revise a quote":{"note":"Upravit dříve předloženou cenovou nabídku.","example":"We need to revise the quote to reflect the updated scope."},"cust:binding offer":{"note":"Nabídka, kterou je nabízející strana právně zavázána dodržet, pokud je přijata.","example":"This is a binding offer valid for thirty days."},"cust:to be cost-competitive":{"note":"Nabízet srovnatelnou nebo lepší cenu než konkurence.","example":"We had to lower the price slightly to stay cost-competitive."},"cust:to include in the scope":{"note":"Zahrnout určitou položku nebo práci do rozsahu dodávky.","example":"Installation can be included in the scope for an additional fee."},"cust:additional cost":{"note":"Náklady navíc oproti původně plánovanému rozpočtu.","example":"Any changes to the design will result in additional cost."},"cust:penalty clause":{"note":"Smluvní ustanovení stanovující sankci za nesplnění podmínek smlouvy.","example":"The contract includes a penalty clause for late delivery."},"cust:to finalise the contract":{"note":"Dokončit a uzavřít smlouvu po dohodnutí všech podmínek.","example":"We expect to finalise the contract by the end of the month."},"cust:I understand your frustration.":{"note":"Vyjádření empatie vůči nespokojenosti zákazníka.","example":"I understand your frustration - this delay has caused real problems for you."},"cust:Let me look into this for you.":{"note":"Slib, že se mluvčí problémem bude osobně zabývat.","example":"Let me look into this for you and get back to you by tomorrow."},"cust:We take this matter seriously.":{"note":"Ujištění, že firma přistupuje k problému s plnou vážností.","example":"We take this matter seriously and have already started an internal investigation."},"cust:I'll get back to you with an update.":{"note":"Slib informovat zákazníka o aktuálním vývoji v blízké budoucnosti.","example":"I'll get back to you with an update by the end of the day."},"cust:We apologise for the inconvenience.":{"note":"Formální omluva za způsobené potíže nebo nepříjemnosti.","example":"We apologise for the inconvenience caused by the delayed shipment."},"cust:to escalate a complaint":{"note":"Postoupit stížnost na vyšší úroveň řešení, pokud nebyla vyřešena standardním postupem.","example":"The customer decided to escalate the complaint to senior management."},"cust:root cause of the complaint":{"note":"Skutečná, základní příčina, která vedla ke vzniku stížnosti.","example":"The root cause of the complaint was traced back to a shipping error."},"cust:compensation":{"note":"Finanční nebo jiná náhrada poskytnutá za způsobenou škodu nebo problém.","example":"The customer was offered compensation for the production losses."},"cust:to make things right":{"note":"Napravit situaci k spokojenosti druhé strany.","example":"We want to make things right, so we're sending a replacement part free of charge."},"cust:service recovery":{"note":"Proces napravení chyby v servisu tak, aby byla obnovena spokojenost zákazníka.","example":"Good service recovery can actually strengthen the relationship with a customer."},"cust:to prevent a recurrence":{"note":"Zajistit, aby se stejný problém znovu neopakoval.","example":"We updated the procedure to prevent a recurrence of this issue."},"cust:to close the loop with the customer":{"note":"Definitivně dořešit záležitost se zákazníkem a potvrdit uspokojivé vyřešení.","example":"Once the part is replaced, we'll close the loop with the customer."},"cust:customer satisfaction":{"note":"Míra spokojenosti zákazníka s produktem nebo službou.","example":"Customer satisfaction improved noticeably after the new support process was introduced."},"genb2:to wake up":{"note":"Probudit se.","example":"I tend to wake up whenever I get the chance."},"genb2:to get dressed":{"note":"Obléknout se.","example":"Try to get dressed before the end of the day."},"genb2:to commute":{"note":"Dojíždět do práce.","example":"We need to commute as soon as possible."},"genb2:to run errands":{"note":"Vyřizovat pochůzky.","example":"It's important to run errands in this kind of situation."},"genb2:to do the chores":{"note":"Dělat domácí práce.","example":"She decided to do the chores after thinking it over."},"genb2:to unwind":{"note":"Odreagovat se.","example":"Sometimes it really helps to unwind."},"genb2:to doze off":{"note":"Usnout, zdřímnout.","example":"He always manages to doze off on time."},"genb2:to oversleep":{"note":"Zaspat.","example":"They plan to oversleep next week."},"genb2:routine":{"note":"Zaběhlý postup, rutina.","example":"We discussed a routine during the meeting."},"genb2:habit":{"note":"Zvyk.","example":"Habit is something we deal with regularly."},"genb2:to be exhausted":{"note":"Být vyčerpaný.","example":"We need to be exhausted as soon as possible."},"genb2:to catch up on sleep":{"note":"Dohnat spánek.","example":"It's important to catch up on sleep in this kind of situation."},"genb2:to be in a rush":{"note":"Spěchat.","example":"She decided to be in a rush after thinking it over."},"genb2:to procrastinate":{"note":"Odkládat věci na později.","example":"Sometimes it really helps to procrastinate."},"genb2:to multitask":{"note":"Dělat víc věcí najednou.","example":"He always manages to multitask on time."},"genb2:to plan ahead":{"note":"Plánovat dopředu.","example":"They plan to plan ahead next week."},"genb2:leisure time":{"note":"Volný čas.","example":"I came across a leisure time in the article I read."},"genb2:to relax":{"note":"Odpočívat.","example":"Try to relax before the end of the day."},"genb2:to be worn out":{"note":"Být utahaný.","example":"We need to be worn out as soon as possible."},"genb2:to stick to a schedule":{"note":"Držet se harmonogramu.","example":"It's important to stick to a schedule in this kind of situation."},"genb2:to skip breakfast":{"note":"Vynechat snídani.","example":"She decided to skip breakfast after thinking it over."},"genb2:to grab a bite":{"note":"Rychle se zakousnout.","example":"Sometimes it really helps to grab a bite."},"genb2:to head off":{"note":"Vyrazit, odejít.","example":"He always manages to head off on time."},"genb2:to settle down":{"note":"Usadit se.","example":"They plan to settle down next week."},"genb2:bedtime":{"note":"Doba spánku.","example":"This is a good example of a bedtime."},"genb2:outgoing":{"note":"Společenský, otevřený.","example":"She seemed outgoing during the interview."},"genb2:reserved":{"note":"Uzavřený, zdrženlivý.","example":"It was a reserved situation to deal with."},"genb2:stubborn":{"note":"Tvrdohlavý.","example":"Stubborn is something we deal with regularly."},"genb2:reliable":{"note":"Spolehlivý.","example":"I found the whole process rather reliable."},"genb2:easy-going":{"note":"Pohodový.","example":"My colleague is known for being easy-going."},"genb2:ambitious":{"note":"Ambiciózní.","example":"He is quite ambitious by nature."},"genb2:generous":{"note":"Štědrý.","example":"She seemed generous during the interview."},"genb2:selfish":{"note":"Sobecký.","example":"We discussed a selfish during the meeting."},"genb2:modest":{"note":"Skromný.","example":"Modest is something we deal with regularly."},"genb2:arrogant":{"note":"Arogantní.","example":"I found the whole process rather arrogant."},"genb2:sensitive":{"note":"Citlivý.","example":"My colleague is known for being sensitive."},"genb2:confident":{"note":"Sebejistý.","example":"He is quite confident by nature."},"genb2:shy":{"note":"Stydlivý.","example":"She seemed shy during the interview."},"genb2:curious":{"note":"Zvědavý.","example":"It was a curious situation to deal with."},"genb2:patient":{"note":"Trpělivý.","example":"They can be patient at times, especially under pressure."},"genb2:impatient":{"note":"Netrpělivý.","example":"I found the whole process rather impatient."},"genb2:honest":{"note":"Upřímný.","example":"Honest played an important role in the final decision."},"genb2:cautious":{"note":"Opatrný.","example":"He is quite cautious by nature."},"genb2:optimistic":{"note":"Optimistický.","example":"She seemed optimistic during the interview."},"genb2:pessimistic":{"note":"Pesimistický.","example":"It was a pessimistic situation to deal with."},"genb2:determined":{"note":"Odhodlaný.","example":"They can be determined at times, especially under pressure."},"genb2:laid-back":{"note":"V klidu, nenapjatý.","example":"I came across a laid-back in the article I read."},"genb2:hard-working":{"note":"Pracovitý.","example":"My colleague is known for being hard-working."},"genb2:moody":{"note":"Náladový.","example":"He is quite moody by nature."},"genb2:trustworthy":{"note":"Důvěryhodný.","example":"She seemed trustworthy during the interview."},"genb2:to feel overwhelmed":{"note":"Cítit se zahlcený.","example":"We need to feel overwhelmed as soon as possible."},"genb2:to feel relieved":{"note":"Cítit se s úlevou.","example":"It's important to feel relieved in this kind of situation."},"genb2:to feel anxious":{"note":"Cítit úzkost.","example":"She decided to feel anxious after thinking it over."},"genb2:to feel embarrassed":{"note":"Stydět se, být trapně.","example":"Sometimes it really helps to feel embarrassed."},"genb2:to feel frustrated":{"note":"Cítit se frustrovaný.","example":"He always manages to feel frustrated on time."},"genb2:to feel jealous":{"note":"Žárlit.","example":"They plan to feel jealous next week."},"genb2:to feel grateful":{"note":"Cítit vděčnost.","example":"I tend to feel grateful whenever I get the chance."},"genb2:to feel homesick":{"note":"Stýskat se po domově.","example":"Try to feel homesick before the end of the day."},"genb2:to feel proud":{"note":"Být pyšný.","example":"We need to feel proud as soon as possible."},"genb2:to feel guilty":{"note":"Cítit se provinile.","example":"It's important to feel guilty in this kind of situation."},"genb2:to burst into tears":{"note":"Propuknout v pláč.","example":"She decided to burst into tears after thinking it over."},"genb2:to lose one's temper":{"note":"Ztratit nervy.","example":"Sometimes it really helps to lose one's temper."},"genb2:to calm down":{"note":"Uklidnit se.","example":"He always manages to calm down on time."},"genb2:to cheer up":{"note":"Rozveselit se.","example":"They plan to cheer up next week."},"genb2:to be fed up":{"note":"Mít toho dost.","example":"I tend to be fed up whenever I get the chance."},"genb2:to be delighted":{"note":"Být nadšený, potěšený.","example":"Try to be delighted before the end of the day."},"genb2:to be furious":{"note":"Být zuřivý.","example":"We need to be furious as soon as possible."},"genb2:to be terrified":{"note":"Být vyděšený.","example":"It's important to be terrified in this kind of situation."},"genb2:mixed feelings":{"note":"Smíšené pocity.","example":"We discussed a mixed feelings during the meeting."},"genb2:to hold a grudge":{"note":"Chovat zášť.","example":"Sometimes it really helps to hold a grudge."},"genb2:to feel down":{"note":"Cítit se skleslý.","example":"He always manages to feel down on time."},"genb2:to be moved":{"note":"Být dojatý.","example":"They plan to be moved next week."},"genb2:to feel reassured":{"note":"Cítit se ujištěný, uklidněný.","example":"I tend to feel reassured whenever I get the chance."},"genb2:to snap at someone":{"note":"Utrhnout se na někoho.","example":"Try to snap at someone before the end of the day."},"genb2:to bottle up feelings":{"note":"Potlačovat city v sobě.","example":"We need to bottle up feelings as soon as possible."},"genb2:to apply for a job":{"note":"Ucházet se o práci.","example":"It's important to apply for a job in this kind of situation."},"genb2:job interview":{"note":"Pracovní pohovor.","example":"I came across a job interview in the article I read."},"genb2:to get promoted":{"note":"Být povýšen.","example":"Sometimes it really helps to get promoted."},"genb2:to hand in one's notice":{"note":"Podat výpověď.","example":"He always manages to hand in one's notice on time."},"genb2:to be laid off":{"note":"Být propuštěn (nadbytečnost).","example":"They plan to be laid off next week."},"genb2:colleague":{"note":"Kolega.","example":"We discussed a colleague during the meeting."},"genb2:deadline":{"note":"Termín, uzávěrka.","example":"Deadline is something we deal with regularly."},"genb2:workload":{"note":"Pracovní vytížení.","example":"I came across a workload in the article I read."},"genb2:to be in charge of":{"note":"Mít na starosti.","example":"It's important to be in charge of in this kind of situation."},"genb2:salary":{"note":"Plat.","example":"He is quite salary by nature."},"genb2:to earn a living":{"note":"Vydělávat si na živobytí.","example":"Sometimes it really helps to earn a living."},"genb2:to be self-employed":{"note":"Být osoba samostatně výdělečně činná.","example":"He always manages to be self-employed on time."},"genb2:to work overtime":{"note":"Pracovat přesčas.","example":"They plan to work overtime next week."},"genb2:to meet a deadline":{"note":"Stihnout termín.","example":"I tend to meet a deadline whenever I get the chance."},"genb2:qualification":{"note":"Kvalifikace.","example":"Qualification played an important role in the final decision."},"genb2:to negotiate a salary":{"note":"Vyjednávat o platu.","example":"We need to negotiate a salary as soon as possible."},"genb2:employee benefits":{"note":"Zaměstnanecké výhody.","example":"The report mentions an employee benefits."},"genb2:to resign":{"note":"Rezignovat.","example":"She decided to resign after thinking it over."},"genb2:to be understaffed":{"note":"Mít nedostatek personálu.","example":"Sometimes it really helps to be understaffed."},"genb2:career path":{"note":"Kariérní dráha.","example":"I came across a career path in the article I read."},"genb2:to burn out":{"note":"Vyhořet (psychicky).","example":"They plan to burn out next week."},"genb2:to network":{"note":"Budovat pracovní kontakty.","example":"I tend to network whenever I get the chance."},"genb2:probation period":{"note":"Zkušební doba.","example":"The report mentions a probation period."},"genb2:to be on sick leave":{"note":"Být na nemocenské.","example":"We need to be on sick leave as soon as possible."},"genb2:performance review":{"note":"Hodnocení výkonu.","example":"Performance review is something we deal with regularly."},"genb2:to enroll in a course":{"note":"Zapsat se do kurzu.","example":"She decided to enroll in a course after thinking it over."},"genb2:to fail an exam":{"note":"Propadnout u zkoušky.","example":"Sometimes it really helps to fail an exam."},"genb2:to pass with flying colours":{"note":"Udělat zkoušku s vyznamenáním.","example":"He always manages to pass with flying colours on time."},"genb2:to cram for an exam":{"note":"Biflovat se na zkoušku.","example":"They plan to cram for an exam next week."},"genb2:assignment":{"note":"Úkol, zadání.","example":"It was a assignment situation to deal with."},"genb2:tuition fees":{"note":"Školné.","example":"Tuition fees is something we deal with regularly."},"genb2:scholarship":{"note":"Stipendium.","example":"I came across a scholarship in the article I read."},"genb2:to drop out":{"note":"Odejít ze školy předčasně.","example":"It's important to drop out in this kind of situation."},"genb2:lecture":{"note":"Přednáška.","example":"This is a good example of a lecture."},"genb2:to take notes":{"note":"Dělat si poznámky.","example":"Sometimes it really helps to take notes."},"genb2:curriculum":{"note":"Učební osnovy.","example":"We discussed a curriculum during the meeting."},"genb2:to revise":{"note":"Opakovat si látku.","example":"They plan to revise next week."},"genb2:to hand in an assignment":{"note":"Odevzdat úkol.","example":"I tend to hand in an assignment whenever I get the chance."},"genb2:plagiarism":{"note":"Plagiátorství.","example":"Plagiarism played an important role in the final decision."},"genb2:to graduate":{"note":"Vystudovat, promovat.","example":"We need to graduate as soon as possible."},"genb2:degree":{"note":"Vysokoškolský titul.","example":"The report mentions a degree."},"genb2:to major in something":{"note":"Studovat jako hlavní obor.","example":"She decided to major in something after thinking it over."},"genb2:mentor":{"note":"Mentor.","example":"Mentor is something we deal with regularly."},"genb2:to fall behind":{"note":"Zaostávat.","example":"He always manages to fall behind on time."},"genb2:to keep up with":{"note":"Držet krok s.","example":"They plan to keep up with next week."},"genb2:distance learning":{"note":"Distanční studium.","example":"This is a good example of a distance learning."},"genb2:to sit an exam":{"note":"Psát zkoušku.","example":"Try to sit an exam before the end of the day."},"genb2:marking scheme":{"note":"Hodnoticí systém.","example":"We discussed a marking scheme during the meeting."},"genb2:literacy":{"note":"Gramotnost.","example":"They can be literacy at times, especially under pressure."},"genb2:to broaden one's horizons":{"note":"Rozšířit si obzory.","example":"She decided to broaden one's horizons after thinking it over."},"genb2:to catch a cold":{"note":"Nachladit se.","example":"Sometimes it really helps to catch a cold."},"genb2:to feel under the weather":{"note":"Necítit se dobře.","example":"He always manages to feel under the weather on time."},"genb2:to recover":{"note":"Zotavit se.","example":"They plan to recover next week."},"genb2:symptom":{"note":"Příznak.","example":"We discussed a symptom during the meeting."},"genb2:to prescribe medicine":{"note":"Předepsat léky.","example":"Try to prescribe medicine before the end of the day."},"genb2:to book an appointment":{"note":"Objednat se na termín.","example":"We need to book an appointment as soon as possible."},"genb2:to have a check-up":{"note":"Jít na preventivní prohlídku.","example":"It's important to have a check-up in this kind of situation."},"genb2:allergy":{"note":"Alergie.","example":"He is quite allergy by nature."},"genb2:to sprain an ankle":{"note":"Vymknout si kotník.","example":"Sometimes it really helps to sprain an ankle."},"genb2:painkiller":{"note":"Lék proti bolesti.","example":"We discussed a painkiller during the meeting."},"genb2:to be on a diet":{"note":"Držet dietu.","example":"They plan to be on a diet next week."},"genb2:balanced diet":{"note":"Vyvážená strava.","example":"I came across a balanced diet in the article I read."},"genb2:stress-related":{"note":"Související se stresem.","example":"My colleague is known for being stress-related."},"genb2:to stay fit":{"note":"Udržovat se v kondici.","example":"We need to stay fit as soon as possible."},"genb2:immune system":{"note":"Imunitní systém.","example":"The report mentions an immune system."},"genb2:to get vaccinated":{"note":"Nechat se očkovat.","example":"She decided to get vaccinated after thinking it over."},"genb2:wellbeing":{"note":"Duševní pohoda.","example":"They can be wellbeing at times, especially under pressure."},"genb2:to work out":{"note":"Cvičit.","example":"He always manages to work out on time."},"genb2:to sprain a muscle":{"note":"Natáhnout si sval.","example":"They plan to sprain a muscle next week."},"genb2:chronic pain":{"note":"Chronická bolest.","example":"This is a good example of a chronic pain."},"genb2:nutritious":{"note":"Výživný.","example":"She seemed nutritious during the interview."},"genb2:to be dehydrated":{"note":"Být dehydrovaný.","example":"We need to be dehydrated as soon as possible."},"genb2:posture":{"note":"Držení těla.","example":"Posture is something we deal with regularly."},"genb2:to book a flight":{"note":"Zarezervovat let.","example":"She decided to book a flight after thinking it over."},"genb2:connecting flight":{"note":"Navazující let.","example":"Connecting flight played an important role in the final decision."},"genb2:boarding pass":{"note":"Palubní vstupenka.","example":"This is a good example of a boarding pass."},"genb2:delayed":{"note":"Zpožděný.","example":"She seemed delayed during the interview."},"genb2:to check in":{"note":"Odbavit se.","example":"I tend to check in whenever I get the chance."},"genb2:luggage allowance":{"note":"Povolený limit zavazadel.","example":"Luggage allowance is something we deal with regularly."},"genb2:itinerary":{"note":"Plán cesty.","example":"I found the whole process rather itinerary."},"genb2:to go sightseeing":{"note":"Jít si prohlédnout památky.","example":"It's important to go sightseeing in this kind of situation."},"genb2:accommodation":{"note":"Ubytování.","example":"This is a good example of an accommodation."},"genb2:to get around":{"note":"Pohybovat se (v okolí).","example":"Sometimes it really helps to get around."},"genb2:traffic jam":{"note":"Dopravní zácpa.","example":"We discussed a traffic jam during the meeting."},"genb2:rush hour":{"note":"Dopravní špička.","example":"Rush hour is something we deal with regularly."},"genb2:public transport":{"note":"Veřejná doprava.","example":"I came across a public transport in the article I read."},"genb2:to miss a connection":{"note":"Zmeškat přípoj.","example":"Try to miss a connection before the end of the day."},"genb2:to check out":{"note":"Odhlásit se (z hotelu).","example":"We need to check out as soon as possible."},"genb2:customs":{"note":"Celnice.","example":"The report mentions a customs."},"genb2:to go through security":{"note":"Projít bezpečnostní kontrolou.","example":"She decided to go through security after thinking it over."},"genb2:layover":{"note":"Mezipřistání.","example":"Layover is something we deal with regularly."},"genb2:to hire a car":{"note":"Půjčit si auto.","example":"He always manages to hire a car on time."},"genb2:off the beaten track":{"note":"Mimo turistické trasy.","example":"Off the beaten track played an important role in the final decision."},"genb2:jet lag":{"note":"Časový posun.","example":"This is a good example of a jet lag."},"genb2:to chop":{"note":"Krájet.","example":"Try to chop before the end of the day."},"genb2:to grate":{"note":"Strouhat.","example":"We need to grate as soon as possible."},"genb2:to simmer":{"note":"Vařit na mírném ohni.","example":"It's important to simmer in this kind of situation."},"genb2:to season":{"note":"Dochutit, okořenit.","example":"She decided to season after thinking it over."},"genb2:to stir":{"note":"Míchat.","example":"Sometimes it really helps to stir."},"genb2:recipe":{"note":"Recept.","example":"This is a good example of a recipe."},"genb2:ingredient":{"note":"Přísada.","example":"She seemed ingredient during the interview."},"genb2:to taste bland":{"note":"Chutnat mdle.","example":"I tend to taste bland whenever I get the chance."},"genb2:to be starving":{"note":"Mít strašný hlad.","example":"Try to be starving before the end of the day."},"genb2:takeaway":{"note":"Jídlo s sebou.","example":"I found the whole process rather takeaway."},"genb2:to skip a meal":{"note":"Vynechat jídlo.","example":"It's important to skip a meal in this kind of situation."},"genb2:leftovers":{"note":"Zbytky jídla.","example":"This is a good example of a leftovers."},"genb2:to go off":{"note":"Zkazit se (o jídle).","example":"Sometimes it really helps to go off."},"genb2:spicy":{"note":"Pikantní.","example":"It was a spicy situation to deal with."},"genb2:processed food":{"note":"Průmyslově zpracované jídlo.","example":"Processed food is something we deal with regularly."},"genb2:to overeat":{"note":"Přejídat se.","example":"I tend to overeat whenever I get the chance."},"genb2:staple food":{"note":"Základní potravina.","example":"Staple food played an important role in the final decision."},"genb2:to grab a snack":{"note":"Dát si svačinku.","example":"We need to grab a snack as soon as possible."},"genb2:to have a sweet tooth":{"note":"Mít rád sladké.","example":"It's important to have a sweet tooth in this kind of situation."},"genb2:to marinate":{"note":"Marinovat.","example":"She decided to marinate after thinking it over."},"genb2:to overcook":{"note":"Převařit, přepéct.","example":"Sometimes it really helps to overcook."},"genb2:to whisk":{"note":"Šlehat.","example":"He always manages to whisk on time."},"genb2:to bargain":{"note":"Smlouvat o ceně.","example":"They plan to bargain next week."},"genb2:to be a bargain":{"note":"Být výhodná koupě.","example":"I tend to be a bargain whenever I get the chance."},"genb2:refund":{"note":"Vrácení peněz.","example":"The report mentions a refund."},"genb2:receipt":{"note":"Účtenka.","example":"We discussed a receipt during the meeting."},"genb2:to be overpriced":{"note":"Být předražený.","example":"It's important to be overpriced in this kind of situation."},"genb2:to be on a tight budget":{"note":"Mít napjatý rozpočet.","example":"She decided to be on a tight budget after thinking it over."},"genb2:to save up for something":{"note":"Šetřit si na něco.","example":"Sometimes it really helps to save up for something."},"genb2:to be in debt":{"note":"Být zadlužený.","example":"He always manages to be in debt on time."},"genb2:instalment":{"note":"Splátka.","example":"She seemed instalment during the interview."},"genb2:to make ends meet":{"note":"Vyjít s penězi.","example":"I tend to make ends meet whenever I get the chance."},"genb2:second-hand":{"note":"Z druhé ruky.","example":"Second-hand is something we deal with regularly."},"genb2:warranty":{"note":"Záruka.","example":"I found the whole process rather warranty."},"genb2:to return an item":{"note":"Vrátit zboží.","example":"It's important to return an item in this kind of situation."},"genb2:to be a rip-off":{"note":"Být zlodějna, přehnaná cena.","example":"She decided to be a rip-off after thinking it over."},"genb2:loyalty card":{"note":"Věrnostní karta.","example":"The report mentions a loyalty card."},"genb2:to splash out":{"note":"Utratit hodně za jednu věc.","example":"He always manages to splash out on time."},"genb2:to window shop":{"note":"Chodit se dívat do výloh.","example":"They plan to window shop next week."},"genb2:customer service":{"note":"Zákaznický servis.","example":"I came across a customer service in the article I read."},"genb2:to haggle":{"note":"Smlouvat.","example":"Try to haggle before the end of the day."},"genb2:to be cash-strapped":{"note":"Mít nedostatek peněz.","example":"We need to be cash-strapped as soon as possible."},"genb2:to rent a flat":{"note":"Pronajímat si byt.","example":"It's important to rent a flat in this kind of situation."},"genb2:landlord":{"note":"Pronajímatel.","example":"We discussed a landlord during the meeting."},"genb2:tenant":{"note":"Nájemník.","example":"They can be tenant at times, especially under pressure."},"genb2:deposit":{"note":"Kauce.","example":"I came across a deposit in the article I read."},"genb2:to move in":{"note":"Nastěhovat se.","example":"They plan to move in next week."},"genb2:to move out":{"note":"Vystěhovat se.","example":"I tend to move out whenever I get the chance."},"genb2:to renovate":{"note":"Renovovat.","example":"Try to renovate before the end of the day."},"genb2:spacious":{"note":"Prostorný.","example":"It was a spacious situation to deal with."},"genb2:cosy":{"note":"Útulný.","example":"They can be cosy at times, especially under pressure."},"genb2:utility bills":{"note":"Účty za energie.","example":"I came across an utility bills in the article I read."},"genb2:to be fully furnished":{"note":"Být plně zařízený.","example":"Sometimes it really helps to be fully furnished."},"genb2:neighbourhood":{"note":"Sousedství, čtvrť.","example":"This is a good example of a neighbourhood."},"genb2:to do up a house":{"note":"Zrekonstruovat dům.","example":"They plan to do up a house next week."},"genb2:household chores":{"note":"Domácí práce.","example":"We discussed a household chores during the meeting."},"genb2:mortgage":{"note":"Hypotéka.","example":"Mortgage is something we deal with regularly."},"genb2:to be in the middle of nowhere":{"note":"Být na samotě u lesa.","example":"We need to be in the middle of nowhere as soon as possible."},"genb2:to sublet":{"note":"Podnajmout.","example":"It's important to sublet in this kind of situation."},"genb2:appliance":{"note":"Domácí spotřebič.","example":"This is a good example of an appliance."},"genb2:draughty":{"note":"Průvanový, studený.","example":"She seemed draughty during the interview."},"genb2:to be run-down":{"note":"Být zchátralý.","example":"He always manages to be run-down on time."},"genb2:forecast":{"note":"Předpověď.","example":"Forecast is something we deal with regularly."},"genb2:drizzle":{"note":"Mrholení.","example":"I came across a drizzle in the article I read."},"genb2:humid":{"note":"Vlhko, dusno.","example":"Humid played an important role in the final decision."},"genb2:heatwave":{"note":"Vlna veder.","example":"This is a good example of a heatwave."},"genb2:to pour with rain":{"note":"Lít jako z konve.","example":"It's important to pour with rain in this kind of situation."},"genb2:global warming":{"note":"Globální oteplování.","example":"We discussed a global warming during the meeting."},"genb2:carbon footprint":{"note":"Uhlíková stopa.","example":"Carbon footprint is something we deal with regularly."},"genb2:renewable energy":{"note":"Obnovitelná energie.","example":"I came across a renewable energy in the article I read."},"genb2:to recycle":{"note":"Recyklovat.","example":"They plan to recycle next week."},"genb2:pollution":{"note":"Znečištění.","example":"This is a good example of a pollution."},"genb2:drought":{"note":"Sucho.","example":"The report mentions a drought."},"genb2:endangered species":{"note":"Ohrožený druh.","example":"We discussed an endangered species during the meeting."},"genb2:sustainable":{"note":"Udržitelný.","example":"They can be sustainable at times, especially under pressure."},"genb2:to conserve resources":{"note":"Šetřit zdroje.","example":"She decided to conserve resources after thinking it over."},"genb2:greenhouse gases":{"note":"Skleníkové plyny.","example":"Greenhouse gases played an important role in the final decision."},"genb2:deforestation":{"note":"Odlesňování.","example":"This is a good example of a deforestation."},"genb2:single-use plastic":{"note":"Jednorázový plast.","example":"The report mentions a single-use plastic."},"genb2:extreme weather":{"note":"Extrémní počasí.","example":"We discussed an extreme weather during the meeting."},"genb2:to have an impact on":{"note":"Mít vliv na.","example":"Try to have an impact on before the end of the day."},"genb2:eco-friendly":{"note":"Šetrný k životnímu prostředí.","example":"I found the whole process rather eco-friendly."},"genb2:to go viral":{"note":"Stát se virálním.","example":"It's important to go viral in this kind of situation."},"genb2:to stream a video":{"note":"Streamovat video.","example":"She decided to stream a video after thinking it over."},"genb2:to upload":{"note":"Nahrát (soubor).","example":"Sometimes it really helps to upload."},"genb2:to charge a battery":{"note":"Nabít baterii.","example":"He always manages to charge a battery on time."},"genb2:device":{"note":"Zařízení.","example":"Device is something we deal with regularly."},"genb2:to update software":{"note":"Aktualizovat software.","example":"I tend to update software whenever I get the chance."},"genb2:to back up files":{"note":"Zálohovat soubory.","example":"Try to back up files before the end of the day."},"genb2:password":{"note":"Heslo.","example":"This is a good example of a password."},"genb2:to hack":{"note":"Hacknout, nabourat se.","example":"It's important to hack in this kind of situation."},"genb2:screen time":{"note":"Čas strávený u obrazovky.","example":"We discussed a screen time during the meeting."},"genb2:to scroll through":{"note":"Listovat, scrollovat.","example":"Sometimes it really helps to scroll through."},"genb2:fake news":{"note":"Dezinformace, falešné zprávy.","example":"I came across a fake news in the article I read."},"genb2:to go offline":{"note":"Odpojit se.","example":"They plan to go offline next week."},"genb2:subscription":{"note":"Předplatné.","example":"This is a good example of a subscription."},"genb2:to livestream":{"note":"Vysílat živě.","example":"Try to livestream before the end of the day."},"genb2:to double-check":{"note":"Znovu si ověřit.","example":"We need to double-check as soon as possible."},"genb2:social media influencer":{"note":"Influencer.","example":"Social media influencer is something we deal with regularly."},"genb2:to troubleshoot":{"note":"Řešit technický problém.","example":"She decided to troubleshoot after thinking it over."},"genb2:bandwidth":{"note":"Šířka pásma.","example":"Bandwidth played an important role in the final decision."},"genb2:to unplug":{"note":"Odpojit ze zásuvky.","example":"He always manages to unplug on time."},"genb2:to get along with":{"note":"Vycházet s někým.","example":"They plan to get along with next week."},"genb2:to fall out with someone":{"note":"Pohádat se s někým.","example":"I tend to fall out with someone whenever I get the chance."},"genb2:to make up":{"note":"Usmířit se.","example":"Try to make up before the end of the day."},"genb2:acquaintance":{"note":"Známý (osoba).","example":"I came across an acquaintance in the article I read."},"genb2:to keep in touch":{"note":"Udržovat kontakt.","example":"It's important to keep in touch in this kind of situation."},"genb2:to grow apart":{"note":"Citově se odcizit.","example":"She decided to grow apart after thinking it over."},"genb2:to rely on someone":{"note":"Spoléhat se na někoho.","example":"Sometimes it really helps to rely on someone."},"genb2:to look up to someone":{"note":"Vzhlížet k někomu.","example":"He always manages to look up to someone on time."},"genb2:to let someone down":{"note":"Zklamat někoho.","example":"They plan to let someone down next week."},"genb2:peer pressure":{"note":"Tlak vrstevníků.","example":"I came across a peer pressure in the article I read."},"genb2:to bond with someone":{"note":"Sblížit se s někým.","example":"Try to bond with someone before the end of the day."},"genb2:generation gap":{"note":"Generační propast.","example":"This is a good example of a generation gap."},"genb2:to take someone for granted":{"note":"Brát někoho jako samozřejmost.","example":"It's important to take someone for granted in this kind of situation."},"genb2:upbringing":{"note":"Výchova.","example":"It was a upbringing situation to deal with."},"genb2:to socialise":{"note":"Socializovat, stýkat se s lidmi.","example":"Sometimes it really helps to socialise."},"genb2:community":{"note":"Komunita.","example":"I found the whole process rather community."},"genb2:stereotype":{"note":"Stereotyp.","example":"Stereotype played an important role in the final decision."},"genb2:diversity":{"note":"Různorodost.","example":"He is quite diversity by nature."},"genb2:to fit in":{"note":"Zapadnout, zapadat mezi ostatní.","example":"Try to fit in before the end of the day."},"genb2:to stand out":{"note":"Vyčnívat.","example":"We need to stand out as soon as possible."},"genb2:to take up a hobby":{"note":"Začít se věnovat koníčku.","example":"It's important to take up a hobby in this kind of situation."},"genb2:to be into something":{"note":"Bavit se, zajímat se o něco.","example":"She decided to be into something after thinking it over."},"genb2:board game":{"note":"Deskovka.","example":"Board game played an important role in the final decision."},"genb2:to go for a hike":{"note":"Vyrazit na turistiku.","example":"He always manages to go for a hike on time."},"genb2:gardening":{"note":"Zahradničení.","example":"She seemed gardening during the interview."},"genb2:to collect stamps":{"note":"Sbírat známky.","example":"I tend to collect stamps whenever I get the chance."},"genb2:do-it-yourself (DIY)":{"note":"Kutilství.","example":"Do-it-yourself (DIY) is something we deal with regularly."},"genb2:to binge-watch":{"note":"Sledovat vše najednou (seriál).","example":"We need to binge-watch as soon as possible."},"genb2:to knit":{"note":"Plést.","example":"It's important to knit in this kind of situation."},"genb2:leisure activity":{"note":"Volnočasová aktivita.","example":"This is a good example of a leisure activity."},"genb2:to be a couch potato":{"note":"Být pohovkový povaleč.","example":"Sometimes it really helps to be a couch potato."},"genb2:to sign up for a class":{"note":"Přihlásit se na kurz.","example":"He always manages to sign up for a class on time."},"genb2:competitive":{"note":"Soutěživý.","example":"They can be competitive at times, especially under pressure."},"genb2:to unwind with a book":{"note":"Odreagovat se u knihy.","example":"I tend to unwind with a book whenever I get the chance."},"genb2:pastime":{"note":"Koníček, zábava.","example":"Pastime played an important role in the final decision."},"genb2:to go camping":{"note":"Jet stanovat.","example":"We need to go camping as soon as possible."},"genb2:to be a night owl":{"note":"Být noční sova.","example":"It's important to be a night owl in this kind of situation."},"genb2:to be an early bird":{"note":"Být ranní ptáče.","example":"She decided to be an early bird after thinking it over."},"genb2:to indulge in something":{"note":"Dopřát si něco.","example":"Sometimes it really helps to indulge in something."},"genb2:in my opinion":{"note":"Podle mého názoru.","example":"I came across an in my opinion in the article I read."},"genb2:to agree with someone":{"note":"Souhlasit s někým.","example":"They plan to agree with someone next week."},"genb2:to disagree":{"note":"Nesouhlasit.","example":"I tend to disagree whenever I get the chance."},"genb2:to have a point":{"note":"Mít pravdu, mít pádný argument.","example":"Try to have a point before the end of the day."},"genb2:to be biased":{"note":"Být zaujatý.","example":"We need to be biased as soon as possible."},"genb2:to change one's mind":{"note":"Změnit názor.","example":"It's important to change one's mind in this kind of situation."},"genb2:to bring up a topic":{"note":"Nadhodit téma.","example":"She decided to bring up a topic after thinking it over."},"genb2:to see both sides":{"note":"Vidět obě strany věci.","example":"Sometimes it really helps to see both sides."},"genb2:to argue a case":{"note":"Argumentovat, hájit stanovisko.","example":"He always manages to argue a case on time."},"genb2:to make a compromise":{"note":"Udělat kompromis.","example":"They plan to make a compromise next week."},"genb2:to play devil's advocate":{"note":"Hrát ďáblova advokáta.","example":"I tend to play devil's advocate whenever I get the chance."},"genb2:to back up an argument":{"note":"Podložit argument.","example":"Try to back up an argument before the end of the day."},"genb2:standpoint":{"note":"Stanovisko.","example":"I came across a standpoint in the article I read."},"genb2:to jump to conclusions":{"note":"Dělat unáhlené závěry.","example":"It's important to jump to conclusions in this kind of situation."},"genb2:to weigh up pros and cons":{"note":"Zvážit pro a proti.","example":"She decided to weigh up pros and cons after thinking it over."},"genb2:controversial":{"note":"Kontroverzní.","example":"She seemed controversial during the interview."},"genb2:to speak one's mind":{"note":"Říct otevřeně svůj názor.","example":"He always manages to speak one's mind on time."},"genb2:to convince someone":{"note":"Přesvědčit někoho.","example":"They plan to convince someone next week."},"genb2:to have mixed feelings about":{"note":"Mít o něčem smíšené pocity.","example":"I tend to have mixed feelings about whenever I get the chance."},"genb2:to be open-minded":{"note":"Být otevřený novým myšlenkám.","example":"Try to be open-minded before the end of the day."},"genb2:durable":{"note":"Odolný, trvanlivý.","example":"He is quite durable by nature."},"genb2:fragile":{"note":"Křehký.","example":"The report mentions a fragile."},"genb2:efficient":{"note":"Efektivní.","example":"It was a efficient situation to deal with."},"genb2:convenient":{"note":"Pohodlný, praktický.","example":"They can be convenient at times, especially under pressure."},"genb2:versatile":{"note":"Univerzální, mnohostranný.","example":"I came across a versatile in the article I read."},"genb2:outdated":{"note":"Zastaralý.","example":"My colleague is known for being outdated."},"genb2:state-of-the-art":{"note":"Nejmodernější.","example":"This is a good example of a state-of-the-art."},"genb2:affordable":{"note":"Cenově dostupný.","example":"She seemed affordable during the interview."},"genb2:compact":{"note":"Kompaktní.","example":"We discussed a compact during the meeting."},"genb2:lightweight":{"note":"Lehký.","example":"Lightweight is something we deal with regularly."},"genb2:sturdy":{"note":"Pevný, robustní.","example":"I found the whole process rather sturdy."},"genb2:flimsy":{"note":"Chatrný.","example":"My colleague is known for being flimsy."},"genb2:bulky":{"note":"Objemný.","example":"He is quite bulky by nature."},"genb2:user-friendly":{"note":"Uživatelsky přívětivý.","example":"She seemed user-friendly during the interview."},"genb2:innovative":{"note":"Inovativní.","example":"It was a innovative situation to deal with."},"genb2:practical":{"note":"Praktický.","example":"They can be practical at times, especially under pressure."},"genb2:high-quality":{"note":"Vysoce kvalitní.","example":"I found the whole process rather high-quality."},"genb2:cutting-edge":{"note":"Špičkový, na hraně technologie.","example":"Cutting-edge played an important role in the final decision."},"genb2:adjustable":{"note":"Nastavitelný.","example":"He is quite adjustable by nature."},"genb2:adequate":{"note":"Dostatečný, přiměřený.","example":"The report mentions an adequate."},"genb2:faulty":{"note":"Vadný.","example":"It was a faulty situation to deal with."},"genb2:waterproof":{"note":"Vodotěsný.","example":"Waterproof is something we deal with regularly."},"genb2:noticeable":{"note":"Znatelný, nápadný.","example":"I found the whole process rather noticeable."},"genb2:consistent":{"note":"Konzistentní, důsledný.","example":"My colleague is known for being consistent."},"genb2:however":{"note":"Nicméně.","example":"This is a good example of a however."},"genb2:on the other hand":{"note":"Na druhou stranu.","example":"The report mentions an on the other hand."},"genb2:as a result":{"note":"V důsledku toho.","example":"We discussed an as a result during the meeting."},"genb2:therefore":{"note":"Proto.","example":"Therefore is something we deal with regularly."},"genb2:in addition":{"note":"Navíc.","example":"I came across an in addition in the article I read."},"genb2:apart from that":{"note":"Kromě toho.","example":"Apart from that played an important role in the final decision."},"genb2:in spite of":{"note":"Navzdory.","example":"This is a good example of an in spite of."},"genb2:even though":{"note":"I když.","example":"The report mentions an even though."},"genb2:due to":{"note":"Kvůli, z důvodu.","example":"We discussed a due to during the meeting."},"genb2:as long as":{"note":"Pokud, dokud.","example":"As long as is something we deal with regularly."},"genb2:unless":{"note":"Pokud ne.","example":"I found the whole process rather unless."},"genb2:provided that":{"note":"Za předpokladu, že.","example":"Provided that played an important role in the final decision."},"genb2:to sum up":{"note":"Shrnout.","example":"He always manages to sum up on time."},"genb2:above all":{"note":"Především.","example":"The report mentions an above all."},"genb2:in the meantime":{"note":"Mezitím.","example":"We discussed an in the meantime during the meeting."},"genb2:first and foremost":{"note":"V první řadě.","example":"First and foremost is something we deal with regularly."},"genb2:to put it another way":{"note":"Jinak řečeno.","example":"We need to put it another way as soon as possible."},"genb2:all things considered":{"note":"Se vším všudy, po zvážení.","example":"All things considered played an important role in the final decision."},"genb2:for instance":{"note":"Například.","example":"This is a good example of a for instance."},"genb2:nevertheless":{"note":"Přesto.","example":"She seemed nevertheless during the interview."},"genb2:to break the law":{"note":"Porušit zákon.","example":"He always manages to break the law on time."},"genb2:to be fined":{"note":"Dostat pokutu.","example":"They plan to be fined next week."},"genb2:witness":{"note":"Svědek.","example":"I came across a witness in the article I read."},"genb2:to report a crime":{"note":"Nahlásit zločin.","example":"Try to report a crime before the end of the day."},"genb2:theft":{"note":"Krádež.","example":"This is a good example of a theft."},"genb2:to be robbed":{"note":"Být okraden.","example":"It's important to be robbed in this kind of situation."},"genb2:to break in":{"note":"Vloupat se.","example":"She decided to break in after thinking it over."},"genb2:suspicious":{"note":"Podezřelý.","example":"They can be suspicious at times, especially under pressure."},"genb2:to press charges":{"note":"Podat trestní oznámení.","example":"He always manages to press charges on time."},"genb2:evidence":{"note":"Důkaz.","example":"Evidence played an important role in the final decision."},"genb2:to be arrested":{"note":"Být zatčen.","example":"I tend to be arrested whenever I get the chance."},"genb2:regulation":{"note":"Předpis, nařízení.","example":"The report mentions a regulation."},"genb2:to comply with rules":{"note":"Dodržovat pravidla.","example":"We need to comply with rules as soon as possible."},"genb2:to be liable for":{"note":"Nést odpovědnost za.","example":"It's important to be liable for in this kind of situation."},"genb2:insurance policy":{"note":"Pojistná smlouva.","example":"I came across an insurance policy in the article I read."},"genb2:to file a complaint":{"note":"Podat stížnost.","example":"Sometimes it really helps to file a complaint."},"genb2:neighbourhood watch":{"note":"Sousedská hlídka.","example":"This is a good example of a neighbourhood watch."},"genb2:to trespass":{"note":"Vniknout na cizí pozemek.","example":"They plan to trespass next week."},"genb2:fine print":{"note":"Drobné písmo (ve smlouvě).","example":"We discussed a fine print during the meeting."},"genb2:to abide by the rules":{"note":"Řídit se pravidly.","example":"Try to abide by the rules before the end of the day."},"genb2:to feel queasy":{"note":"Být na zvracení.","example":"We need to feel queasy as soon as possible."},"genb2:to twist an ankle":{"note":"Vyvrtnout si kotník.","example":"It's important to twist an ankle in this kind of situation."},"genb2:balanced meal":{"note":"Vyvážené jídlo.","example":"This is a good example of a balanced meal."},"genb2:to crave something":{"note":"Mít na něco chuť.","example":"Sometimes it really helps to crave something."},"genb2:to be picky about food":{"note":"Být vybíravý na jídlo.","example":"He always manages to be picky about food on time."},"genb2:light-hearted":{"note":"Bezstarostný, veselý.","example":"They can be light-hearted at times, especially under pressure."},"genb2:dependable":{"note":"Spolehlivý (na koho se dá spolehnout).","example":"I found the whole process rather dependable."},"genc1:nonetheless":{"note":"Nicméně, přesto.","example":"My colleague is known for being nonetheless."},"genc1:notwithstanding":{"note":"Navzdory, bez ohledu na.","example":"He is quite notwithstanding by nature."},"genc1:insofar as":{"note":"Pokud jde o, v míře, v jaké.","example":"The report mentions an insofar as."},"genc1:with regard to":{"note":"Pokud jde o, ohledně.","example":"We discussed a with regard to during the meeting."},"genc1:albeit":{"note":"Ačkoli.","example":"Albeit is something we deal with regularly."},"genc1:henceforth":{"note":"Od nynějška, napříště.","example":"I came across a henceforth in the article I read."},"genc1:thereby":{"note":"Tím pádem, čímž.","example":"My colleague is known for being thereby."},"genc1:whereby":{"note":"Čímž, na základě čehož.","example":"He is quite whereby by nature."},"genc1:conversely":{"note":"Naopak.","example":"She seemed conversely during the interview."},"genc1:in the same vein":{"note":"Ve stejném duchu.","example":"We discussed an in the same vein during the meeting."},"genc1:by the same token":{"note":"Ze stejného důvodu.","example":"By the same token is something we deal with regularly."},"genc1:to that end":{"note":"Za tímto účelem.","example":"She decided to that end after thinking it over."},"genc1:on the grounds that":{"note":"Z důvodu, že.","example":"On the grounds that played an important role in the final decision."},"genc1:given that":{"note":"Vzhledem k tomu, že.","example":"This is a good example of a given that."},"genc1:as it stands":{"note":"Tak jak to teď je.","example":"The report mentions an as it stands."},"genc1:all the more so":{"note":"Tím spíš.","example":"We discussed an all the more so during the meeting."},"genc1:in light of":{"note":"Ve světle, s ohledem na.","example":"In light of is something we deal with regularly."},"genc1:for the sake of":{"note":"Kvůli, v zájmu.","example":"I came across a for the sake of in the article I read."},"genc1:to a certain extent":{"note":"Do jisté míry.","example":"It's important to a certain extent in this kind of situation."},"genc1:by and large":{"note":"Vcelku, celkově vzato.","example":"This is a good example of a by and large."},"genc1:to postulate":{"note":"Předpokládat, tvrdit.","example":"Sometimes it really helps to postulate."},"genc1:to substantiate":{"note":"Doložit, podepřít důkazy.","example":"He always manages to substantiate on time."},"genc1:to corroborate":{"note":"Potvrdit, podpořit.","example":"They plan to corroborate next week."},"genc1:to refute":{"note":"Vyvrátit.","example":"I tend to refute whenever I get the chance."},"genc1:to extrapolate":{"note":"Extrapolovat, zobecnit.","example":"Try to extrapolate before the end of the day."},"genc1:to delineate":{"note":"Vymezit, nastínit.","example":"We need to delineate as soon as possible."},"genc1:to elucidate":{"note":"Objasnit.","example":"It's important to elucidate in this kind of situation."},"genc1:to infer":{"note":"Usuzovat, odvodit.","example":"She decided to infer after thinking it over."},"genc1:to underpin":{"note":"Podepřít, být základem.","example":"Sometimes it really helps to underpin."},"genc1:to encompass":{"note":"Zahrnovat.","example":"He always manages to encompass on time."},"genc1:to constitute":{"note":"Tvořit, představovat.","example":"They plan to constitute next week."},"genc1:to attribute something to":{"note":"Přisuzovat něco něčemu.","example":"I tend to attribute something to whenever I get the chance."},"genc1:to reconcile":{"note":"Sladit, smířit.","example":"Try to reconcile before the end of the day."},"genc1:to scrutinise":{"note":"Podrobně zkoumat.","example":"We need to scrutinise as soon as possible."},"genc1:to formulate":{"note":"Formulovat.","example":"It's important to formulate in this kind of situation."},"genc1:to disseminate":{"note":"Šířit, rozšiřovat.","example":"She decided to disseminate after thinking it over."},"genc1:to juxtapose":{"note":"Postavit vedle sebe, konfrontovat.","example":"Sometimes it really helps to juxtapose."},"genc1:to circumvent":{"note":"Obejít (pravidlo, problém).","example":"He always manages to circumvent on time."},"genc1:to mitigate":{"note":"Zmírnit.","example":"They plan to mitigate next week."},"genc1:to exacerbate":{"note":"Zhoršit.","example":"I tend to exacerbate whenever I get the chance."},"genc1:to permeate":{"note":"Prostupovat, prolínat.","example":"Try to permeate before the end of the day."},"genc1:to galvanise":{"note":"Podnítit, pobídnout k akci.","example":"We need to galvanise as soon as possible."},"genc1:to warrant":{"note":"Ospravedlňovat, opravňovat.","example":"It's important to warrant in this kind of situation."},"genc1:to stem from":{"note":"Pramenit z, vycházet z.","example":"She decided to stem from after thinking it over."},"genc1:to hinge on":{"note":"Záviset na, být podmíněno.","example":"Sometimes it really helps to hinge on."},"genc1:to soar":{"note":"Prudce stoupat.","example":"He always manages to soar on time."},"genc1:to plummet":{"note":"Prudce klesnout.","example":"They plan to plummet next week."},"genc1:to plateau":{"note":"Stagnovat, ustálit se.","example":"I tend to plateau whenever I get the chance."},"genc1:to fluctuate":{"note":"Kolísat.","example":"Try to fluctuate before the end of the day."},"genc1:upward trend":{"note":"Rostoucí trend.","example":"This is a good example of an upward trend."},"genc1:to level off":{"note":"Vyrovnat se, stagnovat.","example":"It's important to level off in this kind of situation."},"genc1:marginal increase":{"note":"Nepatrný nárůst.","example":"We discussed a marginal increase during the meeting."},"genc1:exponential growth":{"note":"Exponenciální růst.","example":"Exponential growth is something we deal with regularly."},"genc1:to taper off":{"note":"Postupně slábnout, ustupovat.","example":"He always manages to taper off on time."},"genc1:steady decline":{"note":"Trvalý pokles.","example":"Steady decline played an important role in the final decision."},"genc1:to peak":{"note":"Dosáhnout vrcholu.","example":"I tend to peak whenever I get the chance."},"genc1:to bottom out":{"note":"Dosáhnout dna.","example":"Try to bottom out before the end of the day."},"genc1:a sharp downturn":{"note":"Prudký propad.","example":"We discussed an a sharp downturn during the meeting."},"genc1:incremental change":{"note":"Postupná změna.","example":"Incremental change is something we deal with regularly."},"genc1:to gain momentum":{"note":"Nabírat na síle, dynamice.","example":"She decided to gain momentum after thinking it over."},"genc1:to level out":{"note":"Vyrovnat se.","example":"Sometimes it really helps to level out."},"genc1:a slight dip":{"note":"Mírný propad.","example":"This is a good example of an a slight dip."},"genc1:to be on the rise":{"note":"Být na vzestupu.","example":"They plan to be on the rise next week."},"genc1:volatile":{"note":"Nestálý, kolísavý.","example":"We discussed a volatile during the meeting."},"genc1:stagnant":{"note":"Stagnující.","example":"They can be stagnant at times, especially under pressure."},"genc1:arguably":{"note":"Dalo by se říct, patrně.","example":"I found the whole process rather arguably."},"genc1:to some extent":{"note":"Do jisté míry.","example":"It's important to some extent in this kind of situation."},"genc1:it could be argued that":{"note":"Dalo by se argumentovat, že.","example":"This is a good example of an it could be argued that."},"genc1:presumably":{"note":"Pravděpodobně, patrně.","example":"She seemed presumably during the interview."},"genc1:ostensibly":{"note":"Zdánlivě, navenek.","example":"It was a ostensibly situation to deal with."},"genc1:purportedly":{"note":"Údajně.","example":"They can be purportedly at times, especially under pressure."},"genc1:supposedly":{"note":"Údajně, prý.","example":"I found the whole process rather supposedly."},"genc1:seemingly":{"note":"Zdánlivě.","example":"My colleague is known for being seemingly."},"genc1:apparently":{"note":"Zřejmě, jak se zdá.","example":"He is quite apparently by nature."},"genc1:it would seem that":{"note":"Zdá se, že.","example":"The report mentions an it would seem that."},"genc1:one could say that":{"note":"Dalo by se říct, že.","example":"We discussed an one could say that during the meeting."},"genc1:to a large degree":{"note":"Z velké míry.","example":"Sometimes it really helps to a large degree."},"genc1:broadly speaking":{"note":"Obecně řečeno.","example":"I came across a broadly speaking in the article I read."},"genc1:strictly speaking":{"note":"Přísně vzato.","example":"Strictly speaking played an important role in the final decision."},"genc1:to put it mildly":{"note":"Mírně řečeno.","example":"I tend to put it mildly whenever I get the chance."},"genc1:more often than not":{"note":"Většinou, zpravidla.","example":"The report mentions a more often than not."},"genc1:as far as I am aware":{"note":"Pokud vím.","example":"We discussed an as far as I am aware during the meeting."},"genc1:to the best of my knowledge":{"note":"Podle mých nejlepších znalostí.","example":"It's important to the best of my knowledge in this kind of situation."},"genc1:meticulous":{"note":"Puntičkářský, důkladný.","example":"I found the whole process rather meticulous."},"genc1:resilient":{"note":"Odolný, houževnatý.","example":"My colleague is known for being resilient."},"genc1:pragmatic":{"note":"Pragmatický.","example":"He is quite pragmatic by nature."},"genc1:versatile":{"note":"Všestranný.","example":"The report mentions a versatile."},"genc1:audacious":{"note":"Smělý, troufalý.","example":"It was a audacious situation to deal with."},"genc1:tenacious":{"note":"Vytrvalý, neústupný.","example":"They can be tenacious at times, especially under pressure."},"genc1:prudent":{"note":"Prozíravý, obezřetný.","example":"I found the whole process rather prudent."},"genc1:candid":{"note":"Upřímný, otevřený.","example":"Candid played an important role in the final decision."},"genc1:eloquent":{"note":"Výřečný.","example":"He is quite eloquent by nature."},"genc1:astute":{"note":"Bystrý, prohnaný.","example":"The report mentions an astute."},"genc1:pertinent":{"note":"Relevantní, případný.","example":"It was a pertinent situation to deal with."},"genc1:ambivalent":{"note":"Ambivalentní, rozporuplný.","example":"They can be ambivalent at times, especially under pressure."},"genc1:indispensable":{"note":"Nepostradatelný.","example":"I found the whole process rather indispensable."},"genc1:prevalent":{"note":"Převládající, rozšířený.","example":"My colleague is known for being prevalent."},"genc1:unprecedented":{"note":"Bezprecedentní.","example":"He is quite unprecedented by nature."},"genc1:plausible":{"note":"Věrohodný, pravděpodobný.","example":"She seemed plausible during the interview."},"genc1:inherent":{"note":"Vlastní, inherentní.","example":"It was a inherent situation to deal with."},"genc1:intricate":{"note":"Spletitý, komplikovaný.","example":"Intricate is something we deal with regularly."},"genc1:meagre":{"note":"Nepatrný, skrovný.","example":"I came across a meagre in the article I read."},"genc1:compelling":{"note":"Přesvědčivý, poutavý.","example":"My colleague is known for being compelling."},"genc1:elusive":{"note":"Nepolapitelný, těžko dosažitelný.","example":"He is quite elusive by nature."},"genc1:staggering":{"note":"Ohromující.","example":"She seemed staggering during the interview."},"genc1:meticulously":{"note":"Puntičkářsky, pečlivě.","example":"It was a meticulously situation to deal with."},"genc1:formidable":{"note":"Impozantní, obávaný.","example":"They can be formidable at times, especially under pressure."},"genc1:revenue":{"note":"Výnosy, tržby.","example":"I came across a revenue in the article I read."},"genc1:profit margin":{"note":"Zisková marže.","example":"Profit margin played an important role in the final decision."},"genc1:to break even":{"note":"Dosáhnout bodu zvratu.","example":"He always manages to break even on time."},"genc1:shareholder":{"note":"Akcionář.","example":"The report mentions a shareholder."},"genc1:merger":{"note":"Fúze.","example":"We discussed a merger during the meeting."},"genc1:acquisition":{"note":"Akvizice.","example":"Acquisition is something we deal with regularly."},"genc1:to downsize":{"note":"Zeštíhlit, propouštět.","example":"We need to downsize as soon as possible."},"genc1:supply chain":{"note":"Dodavatelský řetězec.","example":"Supply chain played an important role in the final decision."},"genc1:to outsource":{"note":"Zadat externí firmě.","example":"She decided to outsource after thinking it over."},"genc1:market share":{"note":"Podíl na trhu.","example":"The report mentions a market share."},"genc1:stakeholder":{"note":"Zainteresovaná strana.","example":"We discussed a stakeholder during the meeting."},"genc1:liquidity":{"note":"Likvidita.","example":"They can be liquidity at times, especially under pressure."},"genc1:to go bankrupt":{"note":"Zkrachovat.","example":"I tend to go bankrupt whenever I get the chance."},"genc1:subsidiary":{"note":"Dceřiná společnost.","example":"My colleague is known for being subsidiary."},"genc1:overhead costs":{"note":"Režijní náklady.","example":"This is a good example of an overhead costs."},"genc1:to streamline processes":{"note":"Zefektivnit procesy.","example":"It's important to streamline processes in this kind of situation."},"genc1:recession":{"note":"Recese.","example":"We discussed a recession during the meeting."},"genc1:inflation rate":{"note":"Míra inflace.","example":"Inflation rate is something we deal with regularly."},"genc1:to diversify":{"note":"Diverzifikovat.","example":"He always manages to diversify on time."},"genc1:venture capital":{"note":"Rizikový kapitál.","example":"Venture capital played an important role in the final decision."},"genc1:to underpin the economy":{"note":"Být oporou ekonomiky.","example":"I tend to underpin the economy whenever I get the chance."},"genc1:fiscal policy":{"note":"Fiskální politika.","example":"The report mentions a fiscal policy."},"genc1:to yield a return":{"note":"Přinést výnos.","example":"We need to yield a return as soon as possible."},"genc1:turnover":{"note":"Obrat.","example":"Turnover is something we deal with regularly."},"genc1:legislation":{"note":"Legislativa.","example":"I came across a legislation in the article I read."},"genc1:to enact a law":{"note":"Vydat, přijmout zákon.","example":"Sometimes it really helps to enact a law."},"genc1:constituency":{"note":"Volební obvod.","example":"He is quite constituency by nature."},"genc1:to lobby for something":{"note":"Lobbovat za něco.","example":"They plan to lobby for something next week."},"genc1:bureaucracy":{"note":"Byrokracie.","example":"It was a bureaucracy situation to deal with."},"genc1:to implement a policy":{"note":"Zavést politiku, opatření.","example":"Try to implement a policy before the end of the day."},"genc1:accountability":{"note":"Odpovědnost, zodpovědnost.","example":"I found the whole process rather accountability."},"genc1:referendum":{"note":"Referendum.","example":"Referendum played an important role in the final decision."},"genc1:to grant asylum":{"note":"Udělit azyl.","example":"She decided to grant asylum after thinking it over."},"genc1:sovereignty":{"note":"Suverenita.","example":"She seemed sovereignty during the interview."},"genc1:to curb inflation":{"note":"Krotit inflaci.","example":"He always manages to curb inflation on time."},"genc1:welfare state":{"note":"Sociální stát.","example":"Welfare state is something we deal with regularly."},"genc1:civil liberties":{"note":"Občanské svobody.","example":"I came across a civil liberties in the article I read."},"genc1:to marginalise a group":{"note":"Marginalizovat, vytlačit na okraj.","example":"Try to marginalise a group before the end of the day."},"genc1:polarised society":{"note":"Polarizovaná společnost.","example":"This is a good example of a polarised society."},"genc1:grassroots movement":{"note":"Hnutí zdola.","example":"The report mentions a grassroots movement."},"genc1:to hold someone accountable":{"note":"Činit někoho zodpovědným.","example":"She decided to hold someone accountable after thinking it over."},"genc1:watchdog":{"note":"Dozorčí orgán, hlídací pes.","example":"Watchdog is something we deal with regularly."},"genc1:to undermine trust":{"note":"Podkopat důvěru.","example":"He always manages to undermine trust on time."},"genc1:implication":{"note":"Důsledek, implikace.","example":"Implication played an important role in the final decision."},"genc1:ramification":{"note":"Dopad, důsledek.","example":"This is a good example of a ramification."},"genc1:premise":{"note":"Premisa, výchozí předpoklad.","example":"The report mentions a premise."},"genc1:paradox":{"note":"Paradox.","example":"We discussed a paradox during the meeting."},"genc1:dilemma":{"note":"Dilema.","example":"Dilemma is something we deal with regularly."},"genc1:discrepancy":{"note":"Nesrovnalost.","example":"I found the whole process rather discrepancy."},"genc1:ambiguity":{"note":"Nejednoznačnost.","example":"My colleague is known for being ambiguity."},"genc1:nuance":{"note":"Nuance, odstín.","example":"This is a good example of a nuance."},"genc1:catalyst":{"note":"Katalyzátor.","example":"The report mentions a catalyst."},"genc1:momentum":{"note":"Dynamika, setrvačnost.","example":"We discussed a momentum during the meeting."},"genc1:resilience":{"note":"Psychická odolnost.","example":"Resilience is something we deal with regularly."},"genc1:scepticism":{"note":"Skepse.","example":"I came across a scepticism in the article I read."},"genc1:integrity":{"note":"Integrita, bezúhonnost.","example":"My colleague is known for being integrity."},"genc1:paradigm":{"note":"Paradigma.","example":"This is a good example of a paradigm."},"genc1:legacy":{"note":"Odkaz, dědictví.","example":"She seemed legacy during the interview."},"genc1:repercussion":{"note":"Následek, dopad.","example":"We discussed a repercussion during the meeting."},"genc1:controversy":{"note":"Kontroverze.","example":"They can be controversy at times, especially under pressure."},"genc1:precedent":{"note":"Precedens.","example":"I found the whole process rather precedent."},"genc1:consensus":{"note":"Konsenzus.","example":"Consensus played an important role in the final decision."},"genc1:incentive":{"note":"Pobídka, motivace.","example":"He is quite incentive by nature."},"genc1:threshold":{"note":"Práh, hranice.","example":"The report mentions a threshold."},"genc1:to strike a balance":{"note":"Najít rovnováhu.","example":"She decided to strike a balance after thinking it over."},"genc1:to draw a parallel":{"note":"Přirovnat, udělat paralelu.","example":"Sometimes it really helps to draw a parallel."},"genc1:to set a precedent":{"note":"Vytvořit precedens.","example":"He always manages to set a precedent on time."},"genc1:to bear in mind":{"note":"Mít na paměti.","example":"They plan to bear in mind next week."},"genc1:to take something into account":{"note":"Vzít něco v úvahu.","example":"I tend to take something into account whenever I get the chance."},"genc1:to come to terms with":{"note":"Smířit se s.","example":"Try to come to terms with before the end of the day."},"genc1:to shed light on":{"note":"Vrhnout světlo na.","example":"We need to shed light on as soon as possible."},"genc1:to pave the way for":{"note":"Připravit půdu pro.","example":"It's important to pave the way for in this kind of situation."},"genc1:to raise the bar":{"note":"Zvýšit laťku.","example":"She decided to raise the bar after thinking it over."},"genc1:to be at the forefront of":{"note":"Být v čele, v popředí.","example":"Sometimes it really helps to be at the forefront of."},"genc1:to be a double-edged sword":{"note":"Být dvousečná zbraň.","example":"He always manages to be a double-edged sword on time."},"genc1:to be in the pipeline":{"note":"Být připravováno, v procesu.","example":"They plan to be in the pipeline next week."},"genc1:to hit the nail on the head":{"note":"Trefit hřebík na hlavičku.","example":"I tend to hit the nail on the head whenever I get the chance."},"genc1:to be a driving force":{"note":"Být hnací silou.","example":"Try to be a driving force before the end of the day."},"genc1:to gain traction":{"note":"Získávat na síle, popularitě.","example":"We need to gain traction as soon as possible."},"genc1:to tip the scales":{"note":"Převážit misku vah.","example":"It's important to tip the scales in this kind of situation."},"genc1:to set the record straight":{"note":"Uvést věci na pravou míru.","example":"She decided to set the record straight after thinking it over."},"genc1:to be food for thought":{"note":"Dát k zamyšlení.","example":"Sometimes it really helps to be food for thought."},"genc1:that being said":{"note":"Nicméně, přesto.","example":"We discussed a that being said during the meeting."},"genc1:having said that":{"note":"I tak, nicméně.","example":"Having said that is something we deal with regularly."},"genc1:to put things into perspective":{"note":"Uvést věci na pravou míru.","example":"I tend to put things into perspective whenever I get the chance."},"genc1:all things being equal":{"note":"Za jinak stejných okolností.","example":"All things being equal played an important role in the final decision."},"genc1:as things stand":{"note":"Tak jak to teď vypadá.","example":"This is a good example of an as things stand."},"genc1:to cut a long story short":{"note":"Zkráceně řečeno.","example":"It's important to cut a long story short in this kind of situation."},"genc1:needless to say":{"note":"Netřeba dodávat.","example":"We discussed a needless to say during the meeting."},"genc1:for what it's worth":{"note":"Za zmínku stojí, ať je to platné jak chce.","example":"For what it's worth is something we deal with regularly."},"genc1:at the end of the day":{"note":"Koneckonců.","example":"I came across an at the end of the day in the article I read."},"genc1:when it comes down to it":{"note":"Když na to přijde.","example":"When it comes down to it played an important role in the final decision."},"genc1:to touch on a topic":{"note":"Dotknout se tématu.","example":"I tend to touch on a topic whenever I get the chance."},"genc1:to digress":{"note":"Odbočit od tématu.","example":"Try to digress before the end of the day."},"genc1:to reiterate":{"note":"Zopakovat, znovu zdůraznit.","example":"We need to reiterate as soon as possible."},"genc1:on a related note":{"note":"V souvislosti s tím.","example":"On a related note is something we deal with regularly."},"genc1:to circle back to":{"note":"Vrátit se k tématu.","example":"She decided to circle back to after thinking it over."},"genc1:to make a compelling case":{"note":"Podat přesvědčivý argument.","example":"Sometimes it really helps to make a compelling case."},"genc1:to appeal to reason":{"note":"Apelovat na rozum.","example":"He always manages to appeal to reason on time."},"genc1:to sway public opinion":{"note":"Ovlivnit veřejné mínění.","example":"They plan to sway public opinion next week."},"genc1:to drive home a point":{"note":"Důrazně zdůraznit.","example":"I tend to drive home a point whenever I get the chance."},"genc1:to build a rapport":{"note":"Vybudovat vzájemný vztah, důvěru.","example":"Try to build a rapport before the end of the day."},"genc1:to strike a chord":{"note":"Zasáhnout citlivou strunu.","example":"We need to strike a chord as soon as possible."},"genc1:to capitalise on something":{"note":"Vytěžit z něčeho maximum.","example":"It's important to capitalise on something in this kind of situation."},"genc1:to play on emotions":{"note":"Hrát na city.","example":"She decided to play on emotions after thinking it over."},"genc1:to spin a narrative":{"note":"Vytvořit záměrně zabarvený příběh.","example":"Sometimes it really helps to spin a narrative."},"genc1:to gain leverage":{"note":"Získat páku, vliv.","example":"He always manages to gain leverage on time."},"genc1:to make concessions":{"note":"Dělat ústupky.","example":"They plan to make concessions next week."},"genc1:to appeal to common sense":{"note":"Apelovat na zdravý rozum.","example":"I tend to appeal to common sense whenever I get the chance."},"genc1:to delve into":{"note":"Ponořit se do, prozkoumat do hloubky.","example":"Try to delve into before the end of the day."},"genc1:to branch out":{"note":"Rozšířit svoji činnost.","example":"We need to branch out as soon as possible."},"genc1:to iron out issues":{"note":"Vyřešit problémy.","example":"It's important to iron out issues in this kind of situation."},"genc1:to phase out":{"note":"Postupně vyřadit z provozu.","example":"She decided to phase out after thinking it over."},"genc1:to bring about change":{"note":"Přinést, vyvolat změnu.","example":"Sometimes it really helps to bring about change."},"genc1:to carry through":{"note":"Dotáhnout do konce.","example":"He always manages to carry through on time."},"genc1:to hold off on something":{"note":"Odložit, počkat s něčím.","example":"They plan to hold off on something next week."},"genc1:to grapple with a problem":{"note":"Potýkat se s problémem.","example":"I tend to grapple with a problem whenever I get the chance."},"genc1:to weed out":{"note":"Vyřadit, odstranit nevhodné.","example":"Try to weed out before the end of the day."},"genc1:to level with someone":{"note":"Mluvit s někým na rovinu.","example":"We need to level with someone as soon as possible."},"genc1:to spell out":{"note":"Podrobně vysvětlit.","example":"It's important to spell out in this kind of situation."},"genc1:to tide someone over":{"note":"Pomoct někomu překlenout těžké období.","example":"She decided to tide someone over after thinking it over."},"genc1:to chip away at":{"note":"Postupně ukrajovat, snižovat.","example":"Sometimes it really helps to chip away at."},"genc1:to home in on":{"note":"Zaměřit se přesně na.","example":"He always manages to home in on on time."},"genc1:to gloss over":{"note":"Přejít bez povšimnutí, zlehčit.","example":"They plan to gloss over next week."},"genc1:to be disillusioned":{"note":"Být rozčarovaný.","example":"I tend to be disillusioned whenever I get the chance."},"genc1:to feel disheartened":{"note":"Cítit se skleslý, sklíčený.","example":"Try to feel disheartened before the end of the day."},"genc1:to be apprehensive":{"note":"Mít obavy, být nervózní.","example":"We need to be apprehensive as soon as possible."},"genc1:to be indifferent to":{"note":"Být lhostejný k.","example":"It's important to be indifferent to in this kind of situation."},"genc1:to feel a sense of unease":{"note":"Cítit neklid.","example":"She decided to feel a sense of unease after thinking it over."},"genc1:to be taken aback":{"note":"Být překvapený, zaskočený.","example":"Sometimes it really helps to be taken aback."},"genc1:to harbour resentment":{"note":"Chovat zášť.","example":"He always manages to harbour resentment on time."},"genc1:to feel a pang of guilt":{"note":"Pocítit bodnutí viny.","example":"They plan to feel a pang of guilt next week."},"genc1:to be on edge":{"note":"Být nervózní, ve stresu.","example":"I tend to be on edge whenever I get the chance."},"genc1:to be overcome with emotion":{"note":"Být přemožen emocemi.","example":"Try to be overcome with emotion before the end of the day."},"genc1:to feel a sense of closure":{"note":"Cítit uzavření (kapitoly).","example":"We need to feel a sense of closure as soon as possible."},"genc1:to be at peace with something":{"note":"Být s něčím smířený.","example":"It's important to be at peace with something in this kind of situation."},"genc1:to be wistful":{"note":"Být toužebně zasněný, nostalgický.","example":"She decided to be wistful after thinking it over."},"genc1:to feel a twinge of regret":{"note":"Pocítit náznak lítosti.","example":"Sometimes it really helps to feel a twinge of regret."},"genc1:to be a pressing issue":{"note":"Být naléhavý problém.","example":"He always manages to be a pressing issue on time."},"genc1:to reach a stalemate":{"note":"Dostat se do patové situace.","example":"They plan to reach a stalemate next week."},"genc1:to be at a crossroads":{"note":"Být na rozcestí.","example":"I tend to be at a crossroads whenever I get the chance."},"genc1:to be an uphill battle":{"note":"Být boj do kopce.","example":"Try to be an uphill battle before the end of the day."},"genc1:to hit a snag":{"note":"Narazit na zádrhel.","example":"We need to hit a snag as soon as possible."},"genc1:to be a recurring problem":{"note":"Být opakující se problém.","example":"It's important to be a recurring problem in this kind of situation."},"genc1:root cause":{"note":"Kořenová příčina.","example":"I came across a root cause in the article I read."},"genc1:to reach a deadlock":{"note":"Dostat se do slepé uličky.","example":"Sometimes it really helps to reach a deadlock."},"genc1:to be a vicious circle":{"note":"Být začarovaný kruh.","example":"He always manages to be a vicious circle on time."},"genc1:underlying issue":{"note":"Podkladový, skrytý problém.","example":"The report mentions an underlying issue."},"genc1:to exacerbate a situation":{"note":"Zhoršit situaci.","example":"I tend to exacerbate a situation whenever I get the chance."},"genc1:to be a slippery slope":{"note":"Být kluzký svah (nebezpečný trend).","example":"Try to be a slippery slope before the end of the day."},"genc1:hypothesis":{"note":"Hypotéza.","example":"I came across a hypothesis in the article I read."},"genc1:to yield results":{"note":"Přinést výsledky.","example":"It's important to yield results in this kind of situation."},"genc1:empirical evidence":{"note":"Empirický důkaz.","example":"This is a good example of an empirical evidence."},"genc1:methodology":{"note":"Metodologie.","example":"She seemed methodology during the interview."},"genc1:to replicate a study":{"note":"Replikovat studii.","example":"He always manages to replicate a study on time."},"genc1:variable":{"note":"Proměnná.","example":"They can be variable at times, especially under pressure."},"genc1:correlation":{"note":"Korelace.","example":"I came across a correlation in the article I read."},"genc1:causation":{"note":"Kauzalita, příčinná souvislost.","example":"Causation played an important role in the final decision."},"genc1:to draw a conclusion":{"note":"Vyvodit závěr.","example":"We need to draw a conclusion as soon as possible."},"genc1:sample size":{"note":"Velikost vzorku.","example":"The report mentions a sample size."},"genc1:bias":{"note":"Zkreslení, předpojatost.","example":"We discussed a bias during the meeting."},"genc1:peer-reviewed":{"note":"Recenzovaný odborníky.","example":"They can be peer-reviewed at times, especially under pressure."},"genc1:to falsify a theory":{"note":"Vyvrátit teorii.","example":"He always manages to falsify a theory on time."},"genc1:anomaly":{"note":"Anomálie.","example":"My colleague is known for being anomaly."},"genc1:longitudinal study":{"note":"Dlouhodobá studie.","example":"This is a good example of a longitudinal study."},"genc1:to be inconclusive":{"note":"Být neprůkazný.","example":"Try to be inconclusive before the end of the day."},"genc1:qualitative data":{"note":"Kvalitativní data.","example":"We discussed a qualitative data during the meeting."},"genc1:to skew results":{"note":"Zkreslit výsledky.","example":"It's important to skew results in this kind of situation."},"genc1:benchmark":{"note":"Měřítko, srovnávací standard.","example":"I came across a benchmark in the article I read."},"genc1:to validate findings":{"note":"Ověřit zjištění.","example":"Sometimes it really helps to validate findings."},"genc1:to undergo a transformation":{"note":"Projít proměnou.","example":"He always manages to undergo a transformation on time."},"genc1:gradual shift":{"note":"Postupný posun.","example":"The report mentions a gradual shift."},"genc1:to overhaul a system":{"note":"Zásadně přepracovat systém.","example":"I tend to overhaul a system whenever I get the chance."},"genc1:to phase something in":{"note":"Postupně zavádět.","example":"Try to phase something in before the end of the day."},"genc1:to revamp":{"note":"Zmodernizovat, přepracovat.","example":"We need to revamp as soon as possible."},"genc1:watershed moment":{"note":"Přelomový okamžik.","example":"Watershed moment played an important role in the final decision."},"genc1:to consolidate gains":{"note":"Upevnit dosažené výsledky.","example":"She decided to consolidate gains after thinking it over."},"genc1:to spearhead a project":{"note":"Vést, stát v čele projektu.","example":"Sometimes it really helps to spearhead a project."},"genc1:to streamline a process":{"note":"Zefektivnit proces.","example":"He always manages to streamline a process on time."},"genc1:irreversible":{"note":"Nevratný.","example":"They can be irreversible at times, especially under pressure."},"genc1:to reshape":{"note":"Přetvořit, přeformovat.","example":"I tend to reshape whenever I get the chance."},"genc1:transitional period":{"note":"Přechodné období.","example":"Transitional period played an important role in the final decision."},"genc1:to institute reforms":{"note":"Zavést reformy.","example":"We need to institute reforms as soon as possible."},"genc1:paradigm shift":{"note":"Zásadní změna paradigmatu.","example":"The report mentions a paradigm shift."},"genc1:to be in a state of flux":{"note":"Být v neustálém pohybu, měnit se.","example":"She decided to be in a state of flux after thinking it over."},"genc1:to portray":{"note":"Vylíčit, zobrazit.","example":"Sometimes it really helps to portray."},"genc1:narrative":{"note":"Vyprávění, narativ.","example":"I found the whole process rather narrative."},"genc1:to evoke emotion":{"note":"Vyvolat emoci.","example":"They plan to evoke emotion next week."},"genc1:aesthetic":{"note":"Estetický.","example":"He is quite aesthetic by nature."},"genc1:to be a masterpiece":{"note":"Být mistrovské dílo.","example":"Try to be a masterpiece before the end of the day."},"genc1:to critique a work":{"note":"Kritizovat, hodnotit dílo.","example":"We need to critique a work as soon as possible."},"genc1:cultural heritage":{"note":"Kulturní dědictví.","example":"Cultural heritage is something we deal with regularly."},"genc1:to be avant-garde":{"note":"Být avantgardní.","example":"She decided to be avant-garde after thinking it over."},"genc1:symbolism":{"note":"Symbolika.","example":"Symbolism played an important role in the final decision."},"genc1:to romanticise":{"note":"Romantizovat.","example":"He always manages to romanticise on time."},"genc1:to be thought-provoking":{"note":"Podněcovat k zamyšlení.","example":"They plan to be thought-provoking next week."},"genc1:subtext":{"note":"Skrytý význam, podtext.","example":"We discussed a subtext during the meeting."},"genc1:to draw inspiration from":{"note":"Čerpat inspiraci z.","example":"Try to draw inspiration from before the end of the day."},"genc1:carbon neutrality":{"note":"Uhlíková neutralita.","example":"I came across a carbon neutrality in the article I read."},"genc1:to offset emissions":{"note":"Kompenzovat emise.","example":"It's important to offset emissions in this kind of situation."},"genc1:biodiversity loss":{"note":"Úbytek biodiverzity.","example":"This is a good example of a biodiversity loss."},"genc1:ecosystem":{"note":"Ekosystém.","example":"The report mentions an ecosystem."},"genc1:to be unsustainable":{"note":"Být neudržitelný.","example":"He always manages to be unsustainable on time."},"genc1:environmental degradation":{"note":"Poškozování životního prostředí.","example":"Environmental degradation is something we deal with regularly."},"genc1:circular economy":{"note":"Cirkulární ekonomika.","example":"I came across a circular economy in the article I read."},"genc1:to phase out fossil fuels":{"note":"Postupně opustit fosilní paliva.","example":"Try to phase out fossil fuels before the end of the day."},"genc1:tipping point":{"note":"Bod zlomu.","example":"This is a good example of a tipping point."},"genc1:to mitigate climate change":{"note":"Zmírnit klimatickou změnu.","example":"It's important to mitigate climate change in this kind of situation."},"genc1:carbon capture":{"note":"Zachytávání uhlíku.","example":"We discussed a carbon capture during the meeting."},"genc1:cognitive bias":{"note":"Kognitivní zkreslení.","example":"Cognitive bias is something we deal with regularly."},"genc1:to rationalise behaviour":{"note":"Racionalizovat chování.","example":"He always manages to rationalise behaviour on time."},"genc1:subconscious":{"note":"Podvědomí.","example":"My colleague is known for being subconscious."},"genc1:to internalise":{"note":"Zvnitřnit.","example":"I tend to internalise whenever I get the chance."},"genc1:self-fulfilling prophecy":{"note":"Sebenaplňující se proroctví.","example":"The report mentions a self-fulfilling prophecy."},"genc1:to project one's feelings":{"note":"Promítat své pocity.","example":"We need to project one's feelings as soon as possible."},"genc1:to conform to norms":{"note":"Přizpůsobit se normám.","example":"She decided to conform to norms after thinking it over."},"genc1:innate":{"note":"Vrozený.","example":"Innate played an important role in the final decision."},"genc1:to be conditioned to":{"note":"Být podmíněný, naučený k.","example":"He always manages to be conditioned to on time."},"genc1:motivation":{"note":"Motivace.","example":"The report mentions a motivation."},"genc1:to suppress an impulse":{"note":"Potlačit impuls.","example":"I tend to suppress an impulse whenever I get the chance."},"genc1:beyond doubt":{"note":"Nade vši pochybnost.","example":"Beyond doubt is something we deal with regularly."},"genc1:in all likelihood":{"note":"Se vší pravděpodobností.","example":"I came across an in all likelihood in the article I read."},"genc1:it stands to reason that":{"note":"Je logické, že.","example":"It stands to reason that played an important role in the final decision."},"genc1:there is every indication that":{"note":"Vše nasvědčuje tomu, že.","example":"This is a good example of a there is every indication that."},"genc1:it remains to be seen":{"note":"Teprve se ukáže.","example":"The report mentions an it remains to be seen."},"genc1:by no means certain":{"note":"Zdaleka ne jisté.","example":"We discussed a by no means certain during the meeting."},"genc1:a foregone conclusion":{"note":"Předem daný závěr.","example":"A foregone conclusion is something we deal with regularly."},"genc1:to cast doubt on":{"note":"Zpochybnit.","example":"I tend to cast doubt on whenever I get the chance."},"genc1:inconclusive evidence":{"note":"Neprůkazný důkaz.","example":"Inconclusive evidence played an important role in the final decision."},"genc1:to take something with a pinch of salt":{"note":"Brát něco s rezervou.","example":"We need to take something with a pinch of salt as soon as possible."},"genc1:to be bound by contract":{"note":"Být vázán smlouvou.","example":"It's important to be bound by contract in this kind of situation."},"genc1:clause":{"note":"Doložka, klauzule.","example":"We discussed a clause during the meeting."},"genc1:to breach an agreement":{"note":"Porušit dohodu.","example":"Sometimes it really helps to breach an agreement."},"genc1:liability":{"note":"Právní odpovědnost.","example":"I found the whole process rather liability."},"genc1:to waive a right":{"note":"Vzdát se práva.","example":"They plan to waive a right next week."},"genc1:null and void":{"note":"Neplatný, zrušený.","example":"This is a good example of a null and void."},"genc1:to indemnify":{"note":"Odškodnit.","example":"Try to indemnify before the end of the day."},"genc1:binding agreement":{"note":"Závazná dohoda.","example":"We discussed a binding agreement during the meeting."},"genc1:to comply with regulations":{"note":"Dodržovat předpisy.","example":"It's important to comply with regulations in this kind of situation."},"genc1:statutory requirement":{"note":"Zákonný požadavek.","example":"I came across a statutory requirement in the article I read."},"genc1:to be exempt from":{"note":"Být osvobozen od.","example":"Sometimes it really helps to be exempt from."},"genc1:jurisdiction":{"note":"Jurisdikce, pravomoc.","example":"This is a good example of a jurisdiction."},"genc1:to litigate":{"note":"Vést soudní spor.","example":"They plan to litigate next week."},"genc1:plaintiff":{"note":"Žalobce.","example":"We discussed a plaintiff during the meeting."},"genc1:to be held liable":{"note":"Nést odpovědnost.","example":"Try to be held liable before the end of the day."},"genc1:to dwindle":{"note":"Postupně ubývat, slábnout.","example":"We need to dwindle as soon as possible."},"genc1:to be deeply rooted in":{"note":"Být hluboce zakořeněný v.","example":"It's important to be deeply rooted in in this kind of situation."},"genc1:a turning point":{"note":"Zlomový bod.","example":"This is a good example of an a turning point."},"genc1:to be a relic of the past":{"note":"Být pozůstatkem minulosti.","example":"Sometimes it really helps to be a relic of the past."},"genc1:to reshape society":{"note":"Přetvořit společnost.","example":"He always manages to reshape society on time."},"genc1:social upheaval":{"note":"Společenský otřes.","example":"Social upheaval is something we deal with regularly."},"genc1:to be steeped in tradition":{"note":"Být prosáklý tradicí.","example":"I tend to be steeped in tradition whenever I get the chance."},"genc1:to break with tradition":{"note":"Porušit tradici.","example":"Try to break with tradition before the end of the day."},"genc1:collective memory":{"note":"Kolektivní paměť.","example":"This is a good example of a collective memory."},"genc1:to be at a historic juncture":{"note":"Být v historickém bodě zlomu.","example":"It's important to be at a historic juncture in this kind of situation."},"genc1:to commemorate":{"note":"Připomínat si, uctívat památku.","example":"She decided to commemorate after thinking it over."},"genc1:to read between the lines":{"note":"Číst mezi řádky.","example":"Sometimes it really helps to read between the lines."},"genc1:to be a blessing in disguise":{"note":"Být požehnáním v přestrojení.","example":"He always manages to be a blessing in disguise on time."},"genc1:to be the tip of the iceberg":{"note":"Být jen špička ledovce.","example":"They plan to be the tip of the iceberg next week."},"genc1:to go back to the drawing board":{"note":"Vrátit se k rýsovacímu prknu.","example":"I tend to go back to the drawing board whenever I get the chance."},"genc1:to jump on the bandwagon":{"note":"Naskočit na vlnu.","example":"Try to jump on the bandwagon before the end of the day."},"genc1:to be at loggerheads":{"note":"Být ve sporu, neshodovat se.","example":"We need to be at loggerheads as soon as possible."},"genc1:to move the goalposts":{"note":"Měnit pravidla za chodu.","example":"It's important to move the goalposts in this kind of situation."},"genc1:to be a game changer":{"note":"Zásadně změnit situaci.","example":"She decided to be a game changer after thinking it over."},"genc1:to throw someone under the bus":{"note":"Hodit někoho přes palubu.","example":"Sometimes it really helps to throw someone under the bus."},"genc1:to take something with a grain of salt":{"note":"Brát něco s rezervou.","example":"He always manages to take something with a grain of salt on time."},"genc1:to be on the same page":{"note":"Být na stejné vlně, mít shodný názor.","example":"They plan to be on the same page next week."},"genc1:to bite the bullet":{"note":"Kousnout do kyselého jablka.","example":"I tend to bite the bullet whenever I get the chance."},"genc1:to cut corners":{"note":"Šidit práci, dělat věci polovičatě.","example":"Try to cut corners before the end of the day."},"genc1:to convey a message":{"note":"Sdělit, předat zprávu.","example":"We need to convey a message as soon as possible."},"genc1:to articulate a view":{"note":"Jasně vyjádřit názor.","example":"It's important to articulate a view in this kind of situation."},"genc1:succinct":{"note":"Výstižný, stručný.","example":"This is a good example of a succinct."},"genc1:verbose":{"note":"Upovídaný, mnohomluvný.","example":"The report mentions a verbose."},"genc1:to be terse":{"note":"Být strohý, úsečný.","example":"He always manages to be terse on time."},"genc1:colloquial":{"note":"Hovorový.","example":"They can be colloquial at times, especially under pressure."},"genc1:to paraphrase":{"note":"Parafrázovat.","example":"I tend to paraphrase whenever I get the chance."},"genc1:tone of voice":{"note":"Tón hlasu.","example":"Tone of voice played an important role in the final decision."},"genc1:to come across as":{"note":"Působit jako, vyznít jako.","example":"We need to come across as as soon as possible."},"genc1:nuanced":{"note":"Jemně odstíněný.","example":"She seemed nuanced during the interview."},"genc1:to overstate":{"note":"Přehánět, nadsazovat.","example":"She decided to overstate after thinking it over."},"genc1:to understate":{"note":"Podceňovat, zlehčovat.","example":"Sometimes it really helps to understate."},"genc1:to be conducive to":{"note":"Prospívat, být příznivé pro.","example":"He always manages to be conducive to on time."},"genc1:to be at variance with":{"note":"Být v rozporu s.","example":"They plan to be at variance with next week."},"genc1:to be predicated on":{"note":"Být založený na, podmíněný.","example":"I tend to be predicated on whenever I get the chance."},"genc1:to be a stopgap solution":{"note":"Být provizorní řešení.","example":"Try to be a stopgap solution before the end of the day."},"genc1:to be tantamount to":{"note":"Rovnat se, být totéž co.","example":"We need to be tantamount to as soon as possible."},"genc1:to be commensurate with":{"note":"Úměrný, odpovídající.","example":"It's important to be commensurate with in this kind of situation."},"genc1:to be a fait accompli":{"note":"Být hotová věc.","example":"She decided to be a fait accompli after thinking it over."},"genc1:to skew the outcome":{"note":"Zkreslit výsledek.","example":"Sometimes it really helps to skew the outcome."},"genc1:to be in the same boat":{"note":"Být na tom stejně.","example":"He always manages to be in the same boat on time."},"genc1:to reach a tipping point":{"note":"Dosáhnout bodu zlomu.","example":"They plan to reach a tipping point next week."},"genc1:to be a case in point":{"note":"Být ukázkovým příkladem.","example":"I tend to be a case in point whenever I get the chance."},"genc1:to set a benchmark":{"note":"Stanovit měřítko, standard.","example":"Try to set a benchmark before the end of the day."},"mech:alloy":{"note":"Slitina.","example":"I found the whole process rather alloy."},"mech:stainless steel":{"note":"Nerezová ocel.","example":"Stainless steel played an important role in the final decision."},"mech:carbon steel":{"note":"Uhlíková ocel.","example":"This is a good example of a carbon steel."},"mech:cast iron":{"note":"Litina.","example":"The report mentions a cast iron."},"mech:aluminium":{"note":"Hliník.","example":"We discussed an aluminium during the meeting."},"mech:brass":{"note":"Mosaz.","example":"Brass is something we deal with regularly."},"mech:bronze":{"note":"Bronz.","example":"I came across a bronze in the article I read."},"mech:composite material":{"note":"Kompozitní materiál.","example":"Composite material played an important role in the final decision."},"mech:yield strength":{"note":"Mez kluzu.","example":"This is a good example of a yield strength."},"mech:tensile strength":{"note":"Mez pevnosti v tahu.","example":"The report mentions a tensile strength."},"mech:ductility":{"note":"Tažnost.","example":"It was a ductility situation to deal with."},"mech:hardness":{"note":"Tvrdost.","example":"Hardness is something we deal with regularly."},"mech:brittleness":{"note":"Křehkost.","example":"I came across a brittleness in the article I read."},"mech:fatigue resistance":{"note":"Odolnost proti únavě materiálu.","example":"Fatigue resistance played an important role in the final decision."},"mech:heat treatment":{"note":"Tepelné zpracování.","example":"This is a good example of a heat treatment."},"mech:annealing":{"note":"Žíhání.","example":"She seemed annealing during the interview."},"mech:quenching":{"note":"Kalení.","example":"It was a quenching situation to deal with."},"mech:tempering":{"note":"Popouštění.","example":"They can be tempering at times, especially under pressure."},"mech:grain structure":{"note":"Struktura zrna materiálu.","example":"I came across a grain structure in the article I read."},"mech:corrosion resistance":{"note":"Odolnost proti korozi.","example":"Corrosion resistance played an important role in the final decision."},"mech:thermal expansion":{"note":"Tepelná roztažnost.","example":"This is a good example of a thermal expansion."},"mech:melting point":{"note":"Teplota tání.","example":"The report mentions a melting point."},"mech:raw material":{"note":"Surovina.","example":"We discussed a raw material during the meeting."},"mech:material fatigue":{"note":"Únava materiálu.","example":"Material fatigue is something we deal with regularly."},"mech:to machine a part":{"note":"Obrábět součást.","example":"We need to machine a part as soon as possible."},"mech:lathe":{"note":"Soustruh.","example":"Lathe played an important role in the final decision."},"mech:milling machine":{"note":"Frézka.","example":"This is a good example of a milling machine."},"mech:CNC machining":{"note":"CNC obrábění.","example":"The report mentions a CNC machining."},"mech:to drill a hole":{"note":"Vyvrtat otvor.","example":"He always manages to drill a hole on time."},"mech:to mill a surface":{"note":"Frézovat plochu.","example":"They plan to mill a surface next week."},"mech:to turn a shaft":{"note":"Soustružit hřídel.","example":"I tend to turn a shaft whenever I get the chance."},"mech:to grind":{"note":"Brousit.","example":"Try to grind before the end of the day."},"mech:surface finish":{"note":"Kvalita povrchu.","example":"This is a good example of a surface finish."},"mech:tool wear":{"note":"Opotřebení nástroje.","example":"The report mentions a tool wear."},"mech:cutting speed":{"note":"Řezná rychlost.","example":"We discussed a cutting speed during the meeting."},"mech:feed rate":{"note":"Posuvová rychlost.","example":"Feed rate is something we deal with regularly."},"mech:chip formation":{"note":"Tvorba třísky.","example":"I came across a chip formation in the article I read."},"mech:coolant":{"note":"Chladicí kapalina.","example":"My colleague is known for being coolant."},"mech:workpiece":{"note":"Obrobek.","example":"This is a good example of a workpiece."},"mech:jig":{"note":"Vrtací nebo montážní přípravek.","example":"The report mentions a jig."},"mech:fixture":{"note":"Upínací přípravek.","example":"We discussed a fixture during the meeting."},"mech:to deburr":{"note":"Odjehlit.","example":"It's important to deburr in this kind of situation."},"mech:burr":{"note":"Otřep.","example":"I came across a burr in the article I read."},"mech:die casting":{"note":"Tlakové lití.","example":"Die casting played an important role in the final decision."},"mech:injection moulding":{"note":"Vstřikování plastů.","example":"This is a good example of an injection moulding."},"mech:forging":{"note":"Kování.","example":"She seemed forging during the interview."},"mech:sheet metal forming":{"note":"Tváření plechu.","example":"We discussed a sheet metal forming during the meeting."},"mech:additive manufacturing":{"note":"Aditivní výroba, 3D tisk.","example":"Additive manufacturing is something we deal with regularly."},"mech:batch production":{"note":"Dávková výroba.","example":"I came across a batch production in the article I read."},"mech:assembly line":{"note":"Montážní linka.","example":"Assembly line played an important role in the final decision."},"mech:bolt":{"note":"Šroub s maticí.","example":"This is a good example of a bolt."},"mech:nut":{"note":"Matice.","example":"The report mentions a nut."},"mech:washer":{"note":"Podložka.","example":"We discussed a washer during the meeting."},"mech:screw":{"note":"Šroub.","example":"Screw is something we deal with regularly."},"mech:rivet":{"note":"Nýt.","example":"I came across a rivet in the article I read."},"mech:torque":{"note":"Utahovací moment.","example":"Torque played an important role in the final decision."},"mech:to tighten a bolt":{"note":"Utáhnout šroub.","example":"We need to tighten a bolt as soon as possible."},"mech:thread pitch":{"note":"Stoupání závitu.","example":"The report mentions a thread pitch."},"mech:thread":{"note":"Závit.","example":"We discussed a thread during the meeting."},"mech:locknut":{"note":"Pojistná matice.","example":"Locknut is something we deal with regularly."},"mech:preload":{"note":"Předpětí.","example":"I came across a preload in the article I read."},"mech:shear force":{"note":"Smykové zatížení.","example":"Shear force played an important role in the final decision."},"mech:weld joint":{"note":"Svarový spoj.","example":"This is a good example of a weld joint."},"mech:welding":{"note":"Svařování.","example":"She seemed welding during the interview."},"mech:brazing":{"note":"Tvrdé pájení.","example":"It was a brazing situation to deal with."},"mech:soldering":{"note":"Měkké pájení.","example":"They can be soldering at times, especially under pressure."},"mech:adhesive bonding":{"note":"Lepené spoje.","example":"I came across an adhesive bonding in the article I read."},"mech:interference fit":{"note":"Přesah, lisovaný spoj.","example":"Interference fit played an important role in the final decision."},"mech:keyway":{"note":"Drážka pro pero.","example":"He is quite keyway by nature."},"mech:spline":{"note":"Drážkování hřídele.","example":"The report mentions a spline."},"mech:retaining ring":{"note":"Pojistný kroužek.","example":"We discussed a retaining ring during the meeting."},"mech:gear":{"note":"Ozubené kolo.","example":"Gear is something we deal with regularly."},"mech:gearbox":{"note":"Převodovka.","example":"I came across a gearbox in the article I read."},"mech:gear ratio":{"note":"Převodový poměr.","example":"Gear ratio played an important role in the final decision."},"mech:shaft":{"note":"Hřídel.","example":"This is a good example of a shaft."},"mech:bearing":{"note":"Ložisko.","example":"She seemed bearing during the interview."},"mech:ball bearing":{"note":"Kuličkové ložisko.","example":"We discussed a ball bearing during the meeting."},"mech:roller bearing":{"note":"Válečkové ložisko.","example":"Roller bearing is something we deal with regularly."},"mech:coupling":{"note":"Spojka.","example":"I found the whole process rather coupling."},"mech:clutch":{"note":"Spojka (mechanismus).","example":"Clutch played an important role in the final decision."},"mech:cam":{"note":"Vačka.","example":"This is a good example of a cam."},"mech:crankshaft":{"note":"Klikový hřídel.","example":"The report mentions a crankshaft."},"mech:piston":{"note":"Píst.","example":"We discussed a piston during the meeting."},"mech:flywheel":{"note":"Setrvačník.","example":"Flywheel is something we deal with regularly."},"mech:pulley":{"note":"Kladka.","example":"I found the whole process rather pulley."},"mech:belt drive":{"note":"Řemenový pohon.","example":"Belt drive played an important role in the final decision."},"mech:chain drive":{"note":"Řetězový pohon.","example":"This is a good example of a chain drive."},"mech:linkage":{"note":"Kloubový mechanismus.","example":"The report mentions a linkage."},"mech:lever":{"note":"Páka.","example":"We discussed a lever during the meeting."},"mech:cog":{"note":"Zub ozubeného kola.","example":"Cog is something we deal with regularly."},"mech:actuator":{"note":"Pohon, aktuátor.","example":"I came across an actuator in the article I read."},"mech:rotational speed":{"note":"Otáčky, rotační rychlost.","example":"Rotational speed played an important role in the final decision."},"mech:torque converter":{"note":"Měnič točivého momentu.","example":"This is a good example of a torque converter."},"mech:backlash":{"note":"Vůle v ozubení.","example":"The report mentions a backlash."},"mech:gear tooth":{"note":"Zub ozubeného kola.","example":"We discussed a gear tooth during the meeting."},"mech:worm gear":{"note":"Šnekový převod.","example":"Worm gear is something we deal with regularly."},"mech:stress":{"note":"Napětí (v materiálu).","example":"I came across a stress in the article I read."},"mech:strain":{"note":"Deformace.","example":"Strain played an important role in the final decision."},"mech:load":{"note":"Zatížení.","example":"This is a good example of a load."},"mech:compressive load":{"note":"Tlakové zatížení.","example":"The report mentions a compressive load."},"mech:tensile load":{"note":"Tahové zatížení.","example":"We discussed a tensile load during the meeting."},"mech:shear stress":{"note":"Smykové napětí.","example":"Shear stress is something we deal with regularly."},"mech:bending moment":{"note":"Ohybový moment.","example":"I came across a bending moment in the article I read."},"mech:deflection":{"note":"Průhyb.","example":"Deflection played an important role in the final decision."},"mech:buckling":{"note":"Vzpěr, boulení.","example":"He is quite buckling by nature."},"mech:factor of safety":{"note":"Součinitel bezpečnosti.","example":"The report mentions a factor of safety."},"mech:stress concentration":{"note":"Koncentrace napětí.","example":"We discussed a stress concentration during the meeting."},"mech:fracture":{"note":"Lom, prasknutí.","example":"Fracture is something we deal with regularly."},"mech:crack propagation":{"note":"Šíření trhliny.","example":"I came across a crack propagation in the article I read."},"mech:elastic deformation":{"note":"Pružná deformace.","example":"Elastic deformation played an important role in the final decision."},"mech:plastic deformation":{"note":"Trvalá deformace.","example":"This is a good example of a plastic deformation."},"mech:modulus of elasticity":{"note":"Modul pružnosti.","example":"The report mentions a modulus of elasticity."},"mech:creep":{"note":"Tečení materiálu.","example":"We discussed a creep during the meeting."},"mech:residual stress":{"note":"Zbytkové napětí.","example":"Residual stress is something we deal with regularly."},"mech:vibration damping":{"note":"Tlumení vibrací.","example":"I came across a vibration damping in the article I read."},"mech:resonance":{"note":"Rezonance.","example":"Resonance played an important role in the final decision."},"mech:static load":{"note":"Statické zatížení.","example":"This is a good example of a static load."},"mech:dynamic load":{"note":"Dynamické zatížení.","example":"The report mentions a dynamic load."},"mech:tolerance":{"note":"Tolerance.","example":"We discussed a tolerance during the meeting."},"mech:dimension":{"note":"Rozměr.","example":"Dimension is something we deal with regularly."},"mech:clearance fit":{"note":"Volný spoj.","example":"I came across a clearance fit in the article I read."},"mech:technical drawing":{"note":"Technický výkres.","example":"Technical drawing played an important role in the final decision."},"mech:blueprint":{"note":"Výkres, projekt.","example":"This is a good example of a blueprint."},"mech:datum":{"note":"Vztažná základna.","example":"The report mentions a datum."},"mech:surface roughness":{"note":"Drsnost povrchu.","example":"We discussed a surface roughness during the meeting."},"mech:scale drawing":{"note":"Výkres v měřítku.","example":"Scale drawing is something we deal with regularly."},"mech:cross-section":{"note":"Průřez.","example":"I came across a cross-section in the article I read."},"mech:orthographic projection":{"note":"Pravoúhlé promítání.","example":"Orthographic projection played an important role in the final decision."},"mech:isometric view":{"note":"Izometrický pohled.","example":"This is a good example of an isometric view."},"mech:assembly drawing":{"note":"Montážní výkres.","example":"The report mentions an assembly drawing."},"mech:bill of materials":{"note":"Kusovník.","example":"We discussed a bill of materials during the meeting."},"mech:revision":{"note":"Revize (výkresu).","example":"Revision is something we deal with regularly."},"mech:geometric dimensioning":{"note":"Geometrické kótování.","example":"I came across a geometric dimensioning in the article I read."},"mech:concentricity":{"note":"Souosost.","example":"My colleague is known for being concentricity."},"mech:flatness":{"note":"Rovinnost.","example":"This is a good example of a flatness."},"mech:perpendicularity":{"note":"Kolmost.","example":"She seemed perpendicularity during the interview."},"mech:parallelism":{"note":"Rovnoběžnost.","example":"We discussed a parallelism during the meeting."},"mech:quality control":{"note":"Kontrola kvality.","example":"Quality control is something we deal with regularly."},"mech:inspection":{"note":"Kontrola, inspekce.","example":"I came across an inspection in the article I read."},"mech:to inspect a part":{"note":"Zkontrolovat součást.","example":"Sometimes it really helps to inspect a part."},"mech:non-destructive testing":{"note":"Nedestruktivní zkoušení.","example":"This is a good example of a non-destructive testing."},"mech:calibration":{"note":"Kalibrace.","example":"The report mentions a calibration."},"mech:gauge":{"note":"Měřidlo.","example":"We discussed a gauge during the meeting."},"mech:caliper":{"note":"Posuvné měřítko.","example":"Caliper is something we deal with regularly."},"mech:micrometer":{"note":"Mikrometr.","example":"I came across a micrometer in the article I read."},"mech:defect":{"note":"Vada.","example":"Defect played an important role in the final decision."},"mech:to fail a test":{"note":"Neprojít zkouškou.","example":"She decided to fail a test after thinking it over."},"mech:root cause analysis":{"note":"Analýza kořenové příčiny.","example":"The report mentions a root cause analysis."},"mech:batch testing":{"note":"Dávkové testování.","example":"We discussed a batch testing during the meeting."},"mech:pressure test":{"note":"Tlaková zkouška.","example":"Pressure test is something we deal with regularly."},"mech:load test":{"note":"Zátěžová zkouška.","example":"I came across a load test in the article I read."},"mech:certificate of conformity":{"note":"Certifikát shody.","example":"Certificate of conformity played an important role in the final decision."},"mech:traceability":{"note":"Sledovatelnost.","example":"He is quite traceability by nature."},"mech:acceptance criteria":{"note":"Kritéria přejímky.","example":"The report mentions an acceptance criteria."},"mech:sampling plan":{"note":"Plán výběru vzorků.","example":"We discussed a sampling plan during the meeting."},"mech:heat exchanger":{"note":"Výměník tepla.","example":"Heat exchanger is something we deal with regularly."},"mech:thermal conductivity":{"note":"Tepelná vodivost.","example":"I came across a thermal conductivity in the article I read."},"mech:convection":{"note":"Proudění (přenos tepla).","example":"Convection played an important role in the final decision."},"mech:conduction":{"note":"Vedení tepla.","example":"This is a good example of a conduction."},"mech:radiation":{"note":"Sálání, záření.","example":"The report mentions a radiation."},"mech:insulation":{"note":"Izolace.","example":"We discussed an insulation during the meeting."},"mech:specific heat capacity":{"note":"Měrná tepelná kapacita.","example":"Specific heat capacity is something we deal with regularly."},"mech:enthalpy":{"note":"Entalpie.","example":"I found the whole process rather enthalpy."},"mech:thermal efficiency":{"note":"Tepelná účinnost.","example":"Thermal efficiency played an important role in the final decision."},"mech:coolant system":{"note":"Chladicí systém.","example":"This is a good example of a coolant system."},"mech:heat sink":{"note":"Chladič.","example":"The report mentions a heat sink."},"mech:thermodynamic cycle":{"note":"Termodynamický cyklus.","example":"We discussed a thermodynamic cycle during the meeting."},"mech:fluid dynamics":{"note":"Dynamika tekutin.","example":"Fluid dynamics is something we deal with regularly."},"mech:viscosity":{"note":"Viskozita.","example":"I found the whole process rather viscosity."},"mech:laminar flow":{"note":"Laminární proudění.","example":"Laminar flow played an important role in the final decision."},"mech:turbulent flow":{"note":"Turbulentní proudění.","example":"This is a good example of a turbulent flow."},"mech:pressure drop":{"note":"Tlaková ztráta.","example":"The report mentions a pressure drop."},"mech:flow rate":{"note":"Průtok.","example":"We discussed a flow rate during the meeting."},"mech:pump":{"note":"Čerpadlo.","example":"Pump is something we deal with regularly."},"mech:compressor":{"note":"Kompresor.","example":"I came across a compressor in the article I read."},"mech:valve":{"note":"Ventil.","example":"Valve played an important role in the final decision."},"mech:nozzle":{"note":"Tryska.","example":"This is a good example of a nozzle."},"mech:cavitation":{"note":"Kavitace.","example":"The report mentions a cavitation."},"mech:hydraulic cylinder":{"note":"Hydraulický válec.","example":"We discussed a hydraulic cylinder during the meeting."},"mech:pneumatic system":{"note":"Pneumatický systém.","example":"Pneumatic system is something we deal with regularly."},"mech:orifice":{"note":"Clona (v potrubí).","example":"I came across an orifice in the article I read."},"mech:back pressure":{"note":"Protitlak.","example":"Back pressure played an important role in the final decision."},"mech:computer-aided design (CAD)":{"note":"Počítačem podporované navrhování.","example":"This is a good example of a computer-aided design (CAD)."},"mech:prototype":{"note":"Prototyp.","example":"The report mentions a prototype."},"mech:to design a component":{"note":"Navrhnout součást.","example":"We need to design a component as soon as possible."},"mech:simulation":{"note":"Simulace.","example":"Simulation is something we deal with regularly."},"mech:finite element analysis":{"note":"Metoda konečných prvků.","example":"I came across a finite element analysis in the article I read."},"mech:3D model":{"note":"3D model.","example":"3D model played an important role in the final decision."},"mech:assembly model":{"note":"Sestava, model sestavy.","example":"This is a good example of an assembly model."},"mech:design iteration":{"note":"Iterace návrhu.","example":"The report mentions a design iteration."},"mech:to optimise a design":{"note":"Optimalizovat návrh.","example":"I tend to optimise a design whenever I get the chance."},"mech:rendering":{"note":"Vizualizace.","example":"They can be rendering at times, especially under pressure."},"mech:to reverse-engineer":{"note":"Provést zpětné inženýrství.","example":"We need to reverse-engineer as soon as possible."},"mech:digital twin":{"note":"Digitální dvojče.","example":"Digital twin played an important role in the final decision."},"mech:safety standard":{"note":"Bezpečnostní norma.","example":"This is a good example of a safety standard."},"mech:risk assessment":{"note":"Hodnocení rizik.","example":"The report mentions a risk assessment."},"mech:personal protective equipment":{"note":"Osobní ochranné pomůcky.","example":"We discussed a personal protective equipment during the meeting."},"mech:hazard":{"note":"Nebezpečí.","example":"Hazard is something we deal with regularly."},"mech:machine guard":{"note":"Kryt stroje.","example":"I came across a machine guard in the article I read."},"mech:lockout-tagout":{"note":"Zajištění stroje proti spuštění.","example":"Lockout-tagout played an important role in the final decision."},"mech:compliance":{"note":"Soulad s předpisy.","example":"This is a good example of a compliance."},"mech:CE marking":{"note":"Označení CE.","example":"The report mentions a CE marking."},"mech:ISO standard":{"note":"Norma ISO.","example":"We discussed an ISO standard during the meeting."},"mech:emergency stop":{"note":"Nouzové zastavení.","example":"Emergency stop is something we deal with regularly."},"mech:interlock":{"note":"Blokovací zařízení.","example":"I came across an interlock in the article I read."},"mech:to comply with regulations":{"note":"Dodržovat předpisy.","example":"They plan to comply with regulations next week."},"mech:wrench":{"note":"Francouzský klíč.","example":"This is a good example of a wrench."},"mech:spanner":{"note":"Klíč na matice.","example":"The report mentions a spanner."},"mech:screwdriver":{"note":"Šroubovák.","example":"We discussed a screwdriver during the meeting."},"mech:pliers":{"note":"Kleště.","example":"Pliers is something we deal with regularly."},"mech:hammer":{"note":"Kladivo.","example":"I came across a hammer in the article I read."},"mech:vice":{"note":"Svěrák.","example":"Vice played an important role in the final decision."},"mech:drill press":{"note":"Sloupová vrtačka.","example":"This is a good example of a drill press."},"mech:hand tool":{"note":"Ruční nářadí.","example":"The report mentions a hand tool."},"mech:torque wrench":{"note":"Momentový klíč.","example":"We discussed a torque wrench during the meeting."},"mech:hoist":{"note":"Kladkostroj, zvedák.","example":"Hoist is something we deal with regularly."},"mech:crane":{"note":"Jeřáb.","example":"I came across a crane in the article I read."},"mech:forklift":{"note":"Vysokozdvižný vozík.","example":"Forklift played an important role in the final decision."},"mech:lead time":{"note":"Dodací lhůta.","example":"This is a good example of a lead time."},"mech:bottleneck":{"note":"Úzké hrdlo (procesu).","example":"The report mentions a bottleneck."},"mech:throughput":{"note":"Propustnost, výkonnost.","example":"We discussed a throughput during the meeting."},"mech:downtime":{"note":"Prostoj.","example":"Downtime is something we deal with regularly."},"mech:preventive maintenance":{"note":"Preventivní údržba.","example":"I came across a preventive maintenance in the article I read."},"mech:predictive maintenance":{"note":"Prediktivní údržba.","example":"Predictive maintenance played an important role in the final decision."},"mech:spare part":{"note":"Náhradní díl.","example":"This is a good example of a spare part."},"mech:root cause":{"note":"Kořenová příčina.","example":"The report mentions a root cause."},"mech:continuous improvement":{"note":"Neustálé zlepšování.","example":"We discussed a continuous improvement during the meeting."},"mech:lean manufacturing":{"note":"Štíhlá výroba.","example":"Lean manufacturing is something we deal with regularly."},"mech:takt time":{"note":"Takt výroby.","example":"I came across a takt time in the article I read."},"mech:work order":{"note":"Pracovní příkaz.","example":"Work order played an important role in the final decision."},"mech:supply chain":{"note":"Dodavatelský řetězec.","example":"This is a good example of a supply chain."},"mech:procurement":{"note":"Nákup, pořizování.","example":"She seemed procurement during the interview."},"mech:motor":{"note":"Elektromotor.","example":"We discussed a motor during the meeting."},"mech:sensor":{"note":"Senzor, čidlo.","example":"Sensor is something we deal with regularly."},"mech:solenoid":{"note":"Elektromagnetická cívka, solenoid.","example":"I came across a solenoid in the article I read."},"mech:wiring":{"note":"Elektroinstalace, zapojení.","example":"My colleague is known for being wiring."},"mech:circuit breaker":{"note":"Jistič.","example":"This is a good example of a circuit breaker."},"mech:programmable logic controller (PLC)":{"note":"Programovatelný logický automat.","example":"The report mentions a programmable logic controller (PLC)."},"mech:voltage":{"note":"Napětí.","example":"We discussed a voltage during the meeting."},"mech:current":{"note":"Elektrický proud.","example":"They can be current at times, especially under pressure."},"mech:short circuit":{"note":"Zkrat.","example":"I came across a short circuit in the article I read."},"mech:earthing / grounding":{"note":"Uzemnění.","example":"Earthing / grounding played an important role in the final decision."},"mech:frequency converter":{"note":"Frekvenční měnič.","example":"This is a good example of a frequency converter."},"mech:velocity":{"note":"Rychlost (vektorová).","example":"She seemed velocity during the interview."},"mech:acceleration":{"note":"Zrychlení.","example":"We discussed an acceleration during the meeting."},"mech:degrees of freedom":{"note":"Stupně volnosti.","example":"Degrees of freedom is something we deal with regularly."},"mech:angular velocity":{"note":"Úhlová rychlost.","example":"I came across an angular velocity in the article I read."},"mech:centre of gravity":{"note":"Těžiště.","example":"Centre of gravity played an important role in the final decision."},"mech:moment of inertia":{"note":"Moment setrvačnosti.","example":"This is a good example of a moment of inertia."},"mech:kinematic chain":{"note":"Kinematický řetězec.","example":"The report mentions a kinematic chain."},"mech:trajectory":{"note":"Trajektorie.","example":"It was a trajectory situation to deal with."},"mech:equilibrium":{"note":"Rovnováha.","example":"Equilibrium is something we deal with regularly."},"mech:friction":{"note":"Tření.","example":"I came across a friction in the article I read."},"mech:kinetic energy":{"note":"Kinetická energie.","example":"Kinetic energy played an important role in the final decision."},"mech:potential energy":{"note":"Potenciální energie.","example":"This is a good example of a potential energy."},"mech:momentum":{"note":"Hybnost.","example":"The report mentions a momentum."},"mech:damping":{"note":"Tlumení.","example":"It was a damping situation to deal with."},"mech:oscillation":{"note":"Kmitání.","example":"Oscillation is something we deal with regularly."},"mech:natural frequency":{"note":"Vlastní frekvence.","example":"I came across a natural frequency in the article I read."},"mech:degrees per second":{"note":"Stupně za sekundu.","example":"Degrees per second played an important role in the final decision."},"mech:coating":{"note":"Povlak, nátěr.","example":"He is quite coating by nature."},"mech:galvanising":{"note":"Pozinkování.","example":"She seemed galvanising during the interview."},"mech:anodising":{"note":"Eloxování.","example":"It was a anodising situation to deal with."},"mech:electroplating":{"note":"Galvanické pokovování.","example":"They can be electroplating at times, especially under pressure."},"mech:powder coating":{"note":"Práškové lakování.","example":"I came across a powder coating in the article I read."},"mech:sandblasting":{"note":"Pískování.","example":"My colleague is known for being sandblasting."},"mech:shot peening":{"note":"Kuličkování.","example":"This is a good example of a shot peening."},"mech:polishing":{"note":"Leštění.","example":"She seemed polishing during the interview."},"mech:passivation":{"note":"Pasivace.","example":"We discussed a passivation during the meeting."},"mech:primer":{"note":"Základní nátěr.","example":"Primer is something we deal with regularly."},"mech:rust":{"note":"Rez.","example":"I came across a rust in the article I read."},"mech:pitting corrosion":{"note":"Bodová koroze.","example":"Pitting corrosion played an important role in the final decision."},"mech:surface treatment":{"note":"Povrchová úprava.","example":"This is a good example of a surface treatment."},"mech:wear-resistant coating":{"note":"Otěruvzdorný povlak.","example":"The report mentions a wear-resistant coating."},"mech:newton":{"note":"Newton (jednotka síly).","example":"We discussed a newton during the meeting."},"mech:pascal":{"note":"Pascal (jednotka tlaku).","example":"They can be pascal at times, especially under pressure."},"mech:joule":{"note":"Joule (jednotka energie).","example":"I came across a joule in the article I read."},"mech:watt":{"note":"Watt (jednotka výkonu).","example":"Watt played an important role in the final decision."},"mech:torque unit (Nm)":{"note":"Jednotka momentu (Nm).","example":"This is a good example of a torque unit (Nm)."},"mech:density":{"note":"Hustota.","example":"She seemed density during the interview."},"mech:mass":{"note":"Hmotnost.","example":"We discussed a mass during the meeting."},"mech:weight":{"note":"Tíha.","example":"Weight is something we deal with regularly."},"mech:volume":{"note":"Objem.","example":"I came across a volume in the article I read."},"mech:displacement":{"note":"Posunutí, objem (motoru).","example":"My colleague is known for being displacement."},"mech:power output":{"note":"Výkon.","example":"This is a good example of a power output."},"mech:efficiency":{"note":"Účinnost.","example":"She seemed efficiency during the interview."},"mech:rpm (revolutions per minute)":{"note":"Otáčky za minutu.","example":"We discussed a rpm (revolutions per minute) during the meeting."},"mech:robotic arm":{"note":"Robotické rameno.","example":"Robotic arm is something we deal with regularly."},"mech:automation":{"note":"Automatizace.","example":"I came across an automation in the article I read."},"mech:feedback loop":{"note":"Zpětnovazební smyčka.","example":"Feedback loop played an important role in the final decision."},"mech:closed-loop control":{"note":"Regulace s uzavřenou smyčkou.","example":"This is a good example of a closed-loop control."},"mech:open-loop control":{"note":"Regulace s otevřenou smyčkou.","example":"The report mentions an open-loop control."},"mech:end effector":{"note":"Koncový efektor robotu.","example":"We discussed an end effector during the meeting."},"mech:conveyor belt":{"note":"Dopravníkový pás.","example":"Conveyor belt is something we deal with regularly."},"mech:pick and place":{"note":"Úkon uchop a polož.","example":"I came across a pick and place in the article I read."},"mech:human-machine interface":{"note":"Rozhraní člověk-stroj.","example":"Human-machine interface played an important role in the final decision."},"mech:machine vision":{"note":"Strojové vidění.","example":"This is a good example of a machine vision."},"mech:payload capacity":{"note":"Nosnost.","example":"The report mentions a payload capacity."},"mech:extrusion":{"note":"Protlačování, extruze.","example":"We discussed an extrusion during the meeting."},"mech:stamping":{"note":"Lisování plechu.","example":"They can be stamping at times, especially under pressure."},"mech:sintering":{"note":"Slinování.","example":"I found the whole process rather sintering."},"mech:laser cutting":{"note":"Laserové řezání.","example":"Laser cutting played an important role in the final decision."},"mech:plasma cutting":{"note":"Plazmové řezání.","example":"This is a good example of a plasma cutting."},"mech:waterjet cutting":{"note":"Řezání vodním paprskem.","example":"The report mentions a waterjet cutting."},"mech:stamping die":{"note":"Lisovací forma.","example":"We discussed a stamping die during the meeting."},"mech:mould":{"note":"Forma, kokila.","example":"Mould is something we deal with regularly."},"mech:draft angle":{"note":"Úkos formy.","example":"I came across a draft angle in the article I read."},"mech:shrinkage":{"note":"Smrštění materiálu.","example":"Shrinkage played an important role in the final decision."},"mech:cycle time":{"note":"Cyklus výroby.","example":"This is a good example of a cycle time."},"mech:scrap rate":{"note":"Míra zmetkovitosti.","example":"The report mentions a scrap rate."},"mech:dial indicator":{"note":"Číselníkový úchylkoměr.","example":"We discussed a dial indicator during the meeting."},"mech:coordinate measuring machine (CMM)":{"note":"Souřadnicový měřicí stroj.","example":"Coordinate measuring machine (CMM) is something we deal with regularly."},"mech:thread gauge":{"note":"Závitové měřidlo.","example":"I came across a thread gauge in the article I read."},"mech:feeler gauge":{"note":"Spárová měrka.","example":"Feeler gauge played an important role in the final decision."},"mech:surface plate":{"note":"Rovinná deska.","example":"This is a good example of a surface plate."},"mech:protractor":{"note":"Úhloměr.","example":"The report mentions a protractor."},"mech:spirit level":{"note":"Vodováha.","example":"We discussed a spirit level during the meeting."},"mech:go/no-go gauge":{"note":"Mezní kalibr.","example":"Go/no-go gauge is something we deal with regularly."},"mech:straightedge":{"note":"Pravítko, přímka.","example":"I came across a straightedge in the article I read."},"mech:spring":{"note":"Pružina.","example":"My colleague is known for being spring."},"mech:compression spring":{"note":"Tlačná pružina.","example":"This is a good example of a compression spring."},"mech:tension spring":{"note":"Tažná pružina.","example":"The report mentions a tension spring."},"mech:spring constant":{"note":"Tuhost pružiny.","example":"We discussed a spring constant during the meeting."},"mech:gasket":{"note":"Těsnění (plošné).","example":"Gasket is something we deal with regularly."},"mech:O-ring":{"note":"O-kroužek.","example":"I found the whole process rather O-ring."},"mech:seal":{"note":"Těsnění.","example":"My colleague is known for being seal."},"mech:shock absorber":{"note":"Tlumič nárazů.","example":"This is a good example of a shock absorber."},"mech:damper":{"note":"Tlumič.","example":"The report mentions a damper."},"mech:rubber mount":{"note":"Pryžové uložení.","example":"We discussed a rubber mount during the meeting."},"mech:preloaded spring":{"note":"Předepnutá pružina.","example":"Preloaded spring is something we deal with regularly."},"mech:leaf spring":{"note":"Listová pružina.","example":"I came across a leaf spring in the article I read."},"mech:diaphragm":{"note":"Membrána.","example":"Diaphragm played an important role in the final decision."},"mech:pipe":{"note":"Trubka, potrubí.","example":"This is a good example of a pipe."},"mech:fitting":{"note":"Armatura, spojka.","example":"She seemed fitting during the interview."},"mech:flange":{"note":"Příruba.","example":"We discussed a flange during the meeting."},"mech:elbow":{"note":"Koleno (potrubí).","example":"Elbow is something we deal with regularly."},"mech:coupling piece":{"note":"Spojovací kus.","example":"I came across a coupling piece in the article I read."},"mech:hose":{"note":"Hadice.","example":"Hose played an important role in the final decision."},"mech:manifold":{"note":"Rozdělovač, sběrné potrubí.","example":"This is a good example of a manifold."},"mech:gate valve":{"note":"Šoupátko.","example":"The report mentions a gate valve."},"mech:ball valve":{"note":"Kulový ventil.","example":"We discussed a ball valve during the meeting."},"mech:check valve":{"note":"Zpětný ventil.","example":"Check valve is something we deal with regularly."},"mech:pipe thread":{"note":"Trubkový závit.","example":"I came across a pipe thread in the article I read."},"mech:pressure rating":{"note":"Tlaková třída.","example":"Pressure rating played an important role in the final decision."},"mech:leak":{"note":"Únik, netěsnost.","example":"This is a good example of a leak."},"mech:to seal a joint":{"note":"Utěsnit spoj.","example":"It's important to seal a joint in this kind of situation."},"mech:bracket":{"note":"Konzola, držák.","example":"We discussed a bracket during the meeting."},"mech:frame":{"note":"Rám.","example":"Frame is something we deal with regularly."},"mech:chassis":{"note":"Podvozek, kostra.","example":"I came across a chassis in the article I read."},"mech:housing":{"note":"Kryt, plášť.","example":"My colleague is known for being housing."},"mech:enclosure":{"note":"Skříň, kryt.","example":"This is a good example of an enclosure."},"mech:panel":{"note":"Panel.","example":"The report mentions a panel."},"mech:base plate":{"note":"Základová deska.","example":"We discussed a base plate during the meeting."},"mech:stiffener":{"note":"Výztuha.","example":"Stiffener is something we deal with regularly."},"mech:rib":{"note":"Žebro (výztuha).","example":"I came across a rib in the article I read."},"mech:gusset":{"note":"Výztužný plech.","example":"Gusset played an important role in the final decision."},"mech:mounting hole":{"note":"Montážní otvor.","example":"This is a good example of a mounting hole."},"mech:cover plate":{"note":"Krycí deska.","example":"The report mentions a cover plate."},"mech:structural member":{"note":"Nosný prvek konstrukce.","example":"We discussed a structural member during the meeting."},"mech:pallet":{"note":"Paleta.","example":"Pallet is something we deal with regularly."},"mech:storage rack":{"note":"Skladovací regál.","example":"I came across a storage rack in the article I read."},"mech:warehouse":{"note":"Sklad.","example":"Warehouse played an important role in the final decision."},"mech:overhead crane":{"note":"Mostový jeřáb.","example":"This is a good example of an overhead crane."},"mech:sling":{"note":"Vázací popruh.","example":"She seemed sling during the interview."},"mech:to hoist a load":{"note":"Zvedat břemeno.","example":"He always manages to hoist a load on time."},"mech:lifting capacity":{"note":"Nosnost zdvihu.","example":"Lifting capacity is something we deal with regularly."},"mech:dolly":{"note":"Přepravní vozík.","example":"I found the whole process rather dolly."},"mech:to stack":{"note":"Skladovat na sobě, stohovat.","example":"Try to stack before the end of the day."},"mech:loading dock":{"note":"Nakládací rampa.","example":"This is a good example of a loading dock."},"mech:gearmotor":{"note":"Převodový motor.","example":"The report mentions a gearmotor."},"mech:splined shaft":{"note":"Drážkovaný hřídel.","example":"We discussed a splined shaft during the meeting."},"mech:keyed shaft":{"note":"Hřídel s perem.","example":"Keyed shaft is something we deal with regularly."},"mech:shim":{"note":"Podložka na doladění vůle.","example":"I came across a shim in the article I read."},"mech:lubricant":{"note":"Mazivo.","example":"My colleague is known for being lubricant."},"mech:grease":{"note":"Tuk (mazivo).","example":"This is a good example of a grease."},"mech:to lubricate":{"note":"Mazat.","example":"Try to lubricate before the end of the day."},"mech:wear and tear":{"note":"Běžné opotřebení.","example":"We discussed a wear and tear during the meeting."},"mech:service life":{"note":"Životnost.","example":"Service life is something we deal with regularly."},"mech:mean time between failures":{"note":"Střední doba mezi poruchami.","example":"I came across a mean time between failures in the article I read."},"mech:commissioning":{"note":"Uvádění do provozu.","example":"My colleague is known for being commissioning."},"mech:decommissioning":{"note":"Vyřazení z provozu.","example":"He is quite decommissioning by nature."},"mech:retrofit":{"note":"Dodatečná úprava, modernizace.","example":"The report mentions a retrofit."},"mech:as-built drawing":{"note":"Výkres skutečného provedení.","example":"We discussed an as-built drawing during the meeting."},"mech:interchangeability":{"note":"Zaměnitelnost dílů.","example":"They can be interchangeability at times, especially under pressure."},"mech:modular design":{"note":"Modulární konstrukce.","example":"I came across a modular design in the article I read."},"mech:obsolescence":{"note":"Zastarávání.","example":"Obsolescence played an important role in the final decision."},"mech:root mean square":{"note":"Efektivní hodnota (RMS).","example":"This is a good example of a root mean square."},"mech:ergonomics":{"note":"Ergonomie.","example":"The report mentions an ergonomics."},"mech:payload":{"note":"Užitečné zatížení.","example":"We discussed a payload during the meeting."},"mech:prototype testing":{"note":"Testování prototypu.","example":"Prototype testing is something we deal with regularly."},"mech:design review":{"note":"Kontrola návrhu.","example":"I came across a design review in the article I read."},"mech:failure mode":{"note":"Způsob poruchy.","example":"Failure mode played an important role in the final decision."},"mech:root cause corrective action":{"note":"Nápravné opatření.","example":"This is a good example of a root cause corrective action."},"mech:engineering change order":{"note":"Příkaz ke změně konstrukce.","example":"The report mentions an engineering change order."},"mech:standard operating procedure":{"note":"Standardní pracovní postup.","example":"We discussed a standard operating procedure during the meeting."},"mech:cross-functional team":{"note":"Mezioborový tým.","example":"Cross-functional team is something we deal with regularly."},"mech:value engineering":{"note":"Hodnotové inženýrství.","example":"I came across a value engineering in the article I read."},"mech:obsolete part":{"note":"Vyřazený, zastaralý díl.","example":"Obsolete part played an important role in the final decision."},"mech:burr removal":{"note":"Odjehlení.","example":"This is a good example of a burr removal."},"mech:dimensional accuracy":{"note":"Rozměrová přesnost.","example":"The report mentions a dimensional accuracy."},"mech:assembly tolerance stack-up":{"note":"Kumulace tolerancí v sestavě.","example":"We discussed an assembly tolerance stack-up during the meeting."}};

function buildDeck(prefix, groups) {
  const cards = [];
  groups.forEach(([tag, items]) => {
    items.forEach(([en, ipa, cz]) => {
      const id = `${prefix}:${en}`;
      const info = CARD_INFO[id];
      cards.push({
        id,
        num: cards.length + 1,
        en,
        ipa,
        cz,
        tag,
        deckId: prefix,
        note: info ? info.note : "",
        example: info ? info.example : "",
      });
    });
  });
  return cards;
}

const DECKS = {
  tech: {
    id: "tech",
    code: "TE",
    name: "Technické termíny",
    desc: "Turbína, pára, ventily, odvodnění, kondenzátor, montáž a troubleshooting",
    cards: buildDeck("tech", TECH_GROUPS),
  },
  cust: {
    id: "cust",
    code: "ZK",
    name: "Zákazník a vyjednávání",
    desc: "Vyjednávání, reportování závad zákazníkovi a fráze na pracovní hovory",
    cards: buildDeck("cust", CUSTOMER_GROUPS),
  },
  genb2: {
    id: "genb2",
    code: "B2",
    name: "Obecná angličtina B2",
    desc: "Každodenní slovní zásoba: práce, vztahy, cestování, zdraví, nakupování a další",
    cards: buildDeck("genb2", GENERAL_B2_GROUPS),
  },
  genc1: {
    id: "genc1",
    code: "C1",
    name: "Obecná angličtina C1",
    desc: "Pokročilá slovní zásoba: akademický a formální jazyk, byznys, idiomy, nuance",
    cards: buildDeck("genc1", GENERAL_C1_GROUPS),
  },
  mech: {
    id: "mech",
    code: "ME",
    name: "Mechanical Engineering",
    desc: "Obecné strojírenství: materiály, obrábění, mechanismy, pevnost, kvalita, nářadí",
    cards: buildDeck("mech", MECH_ENG_GROUPS),
  },
};


const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=Noto+Sans:wght@400&display=swap');

.tf-root{
  --paper:#E4E9E5; --grid:#D4DCD6; --sheet:#F7F8F4; --ink:#15314A; --ink-soft:#4B6275;
  --rule:#A7B7C1; --go:#2E7A57; --stop:#B2432A; --focus:#E0A526;
  min-height:100vh; color:var(--ink);
  background-color:var(--paper);
  background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:28px 28px;
  font-family:'Barlow',system-ui,-apple-system,'Segoe UI',sans-serif;
}
.tf-root *{box-sizing:border-box}
html,body{margin:0;background:#E4E9E5;-webkit-text-size-adjust:100%}
.tf-root{min-height:100dvh;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);-webkit-tap-highlight-color:transparent}
.tf-root button,.tf-scene,.tf-check{touch-action:manipulation;-webkit-user-select:none;user-select:none}
.tf-version{margin:6px 0 0;font-size:.8rem;color:var(--ink-soft)}
.tf-shell{max-width:620px;margin:0 auto;padding:28px 18px 44px}

.tf-hero h1{font-family:'Barlow Condensed',system-ui,sans-serif;font-weight:700;font-size:clamp(2.6rem,9vw,3.6rem);line-height:.95;margin:0 0 10px}
.tf-hero p{margin:0 0 26px;color:var(--ink-soft);font-size:1.05rem;line-height:1.4;max-width:46ch}

.tf-setting{display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap}
.tf-setting-label{font-weight:600;min-width:3.5rem}
.tf-seg{display:inline-flex;border:2px solid var(--ink);border-radius:6px;overflow:hidden;background:var(--sheet)}
.tf-seg button{font:600 1.05rem 'Barlow Condensed',system-ui,sans-serif;padding:8px 18px;border:0;background:transparent;color:var(--ink);cursor:pointer}
.tf-seg button[aria-checked="true"]{background:var(--ink);color:var(--sheet)}

.tf-check{display:flex;align-items:center;gap:10px;margin:4px 0 26px;cursor:pointer}
.tf-check input{width:20px;height:20px;accent-color:#15314A;margin:0}

.tf-decks{display:grid;gap:14px}
.tf-deck{display:flex;gap:16px;align-items:flex-start;width:100%;text-align:left;padding:18px;background:var(--sheet);border:2px solid var(--ink);border-radius:4px;color:var(--ink);font:inherit;cursor:pointer;transition:transform .12s ease,box-shadow .12s ease}
.tf-deck:hover{box-shadow:4px 4px 0 var(--ink);transform:translate(-2px,-2px)}
.tf-deck:disabled{opacity:.6;cursor:wait}
.tf-deck-text{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.tf-deck-name{font:700 1.5rem/1.1 'Barlow Condensed',system-ui,sans-serif}
.tf-deck-desc{color:var(--ink-soft);font-size:.95rem;line-height:1.35}
.tf-meter{display:block;height:6px;background:#D5DDD8;border-radius:3px;overflow:hidden;margin-top:10px}
.tf-meter span{display:block;height:100%;background:var(--go);transition:width .3s ease}
.tf-deck-known{font-size:.88rem;color:var(--ink-soft)}
.tf-reset{margin-top:26px;background:none;border:0;padding:4px 0;color:var(--ink-soft);text-decoration:underline;font:inherit;font-size:.9rem;cursor:pointer}
.tf-reset.is-armed{color:var(--stop);font-weight:600}

.tf-studybar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
.tf-nav{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:6px 2px;color:var(--ink);font:600 1rem 'Barlow',system-ui,sans-serif;cursor:pointer}
.tf-count{color:var(--ink-soft);font-size:.95rem;font-variant-numeric:tabular-nums}
.tf-progress{height:6px;background:#CFD8D2;border-radius:3px;overflow:hidden;margin-bottom:18px}
.tf-progress span{display:block;height:100%;background:var(--go);transition:width .3s ease}

.tf-scene{perspective:1400px;height:clamp(300px,50vh,400px);cursor:pointer;border-radius:4px;outline:none}
.tf-inner{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform .45s cubic-bezier(.3,.7,.25,1)}
.tf-inner.is-flipped{transform:rotateY(180deg)}
.tf-face{position:absolute;inset:0;display:flex;flex-direction:column;border:2px solid var(--ink);border-radius:4px;overflow:hidden;backface-visibility:hidden;-webkit-backface-visibility:hidden;box-shadow:5px 5px 0 rgba(21,49,74,.18)}
.tf-face-front{background:var(--sheet);color:var(--ink)}
.tf-face-back{background:var(--ink);color:var(--sheet);transform:rotateY(180deg)}
.tf-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:24px 22px}
.tf-term{margin:0;font:600 2.3rem/1.12 'Barlow Condensed',system-ui,sans-serif;max-width:22ch;overflow-wrap:anywhere}
.tf-term.is-mid{font-size:1.95rem}
.tf-term.is-long{font-size:1.6rem}
.tf-pron{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
.tf-ipa{font-family:'Noto Sans','Segoe UI','Arial Unicode MS',sans-serif;font-size:1.05rem;color:#2A6A9A}
.tf-face-back .tf-ipa{color:#A6CBE6}
.tf-speak{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;border:2px solid currentColor;background:transparent;color:inherit;cursor:pointer}
.tf-echo{margin:0;font-size:1rem;color:#B9C8D3;max-width:40ch}
.tf-titleblock{display:grid;grid-template-columns:1fr auto auto;border-top:2px solid currentColor;font-size:.85rem}
.tf-titleblock>span{padding:7px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tf-titleblock>span+span{border-left:2px solid currentColor}
.tf-tb-num{font-variant-numeric:tabular-nums}
.tf-tb-lang{font-weight:700;min-width:3.2rem;text-align:center}

.tf-controls{display:flex;gap:12px;margin-top:22px}
.tf-info-btn{margin-left:auto;background:none;border:1px solid var(--line, #ccc);border-radius:999px;padding:6px 14px;font-size:13px;cursor:pointer;color:inherit}
.tf-info-btn.is-active{background:var(--ink);color:var(--sheet)}
.tf-info-panel{margin-top:14px;padding:14px 16px;border-radius:14px;background:rgba(0,0,0,0.05);font-size:14px;line-height:1.45}
.tf-info-note{margin:0 0 8px 0}
.tf-info-example{margin:0;font-style:italic;color:inherit}
.tf-textarea{min-height:64px;resize:vertical;font-family:inherit}

.tf-btn{flex:1;min-height:58px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border:2px solid var(--ink);border-radius:6px;font:700 1.25rem 'Barlow Condensed',system-ui,sans-serif;cursor:pointer;padding:0 16px}
.tf-btn-flip{background:var(--ink);color:var(--sheet)}
.tf-btn-no{background:var(--sheet);color:var(--stop);border-color:var(--stop)}
.tf-btn-yes{background:var(--go);color:#fff;border-color:var(--go)}
.tf-btn-ghost{background:transparent;color:var(--ink)}
.tf-keys{margin:14px 0 0;text-align:center;color:var(--ink-soft);font-size:.85rem}
@media (hover:none){.tf-keys{display:none}}

.tf-done h2{font:700 2.5rem/1 'Barlow Condensed',system-ui,sans-serif;margin:10px 0 10px}
.tf-done-lede{margin:0 0 20px;color:var(--ink-soft);font-size:1.05rem;line-height:1.4}
.tf-missed{list-style:none;margin:0 0 22px;padding:0;background:var(--sheet);border:2px solid var(--ink);border-radius:4px;max-height:42vh;overflow:auto}
.tf-missed li{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 16px;padding:10px 14px}
.tf-missed li+li{border-top:1px solid var(--rule)}
.tf-missed .en{font-weight:600}
.tf-missed .cz{color:var(--ink-soft)}
.tf-done-actions{display:grid;gap:10px}

.tf-root button:focus-visible,.tf-scene:focus-visible,.tf-check input:focus-visible{outline:3px solid var(--focus);outline-offset:3px}

@media (prefers-reduced-motion:reduce){
  .tf-inner,.tf-progress span,.tf-meter span,.tf-deck{transition:none}
}

.tf-splash{min-height:60vh;display:flex;align-items:center;justify-content:center;color:var(--ink-soft)}
.tf-section{margin-top:30px}
.tf-section-title{font:700 1.4rem/1.1 'Barlow Condensed',system-ui,sans-serif;margin:0 0 12px}
.tf-empty{margin:0;padding:16px 18px;border:2px dashed var(--rule);border-radius:4px;background:rgba(247,248,244,.65);color:var(--ink-soft);line-height:1.4}
.tf-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.tf-actions .tf-btn{flex:1 1 200px;min-height:50px;font-size:1.12rem}
.tf-deck-owner{font-size:.9rem;color:var(--ink-soft)}
.tf-badge{display:inline-block;margin-left:8px;padding:1px 8px;border:1.5px solid currentColor;border-radius:999px;font-size:.75rem;font-weight:600;vertical-align:middle;white-space:nowrap}
.tf-banner{margin:0 0 16px;padding:10px 14px;border-left:4px solid var(--focus);background:var(--sheet);font-size:.95rem;line-height:1.35}
.tf-banner.is-error{border-left-color:var(--stop)}

.tf-page-title{font:700 2.2rem/1 'Barlow Condensed',system-ui,sans-serif;margin:12px 0 18px}
.tf-field{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.tf-label{font-weight:600}
.tf-hint{margin:0;font-size:.9rem;color:var(--ink-soft);line-height:1.4}
.tf-input,.tf-select{width:100%;padding:11px 12px;border:2px solid var(--ink);border-radius:4px;background:var(--sheet);color:var(--ink);font:inherit;font-size:1rem}
.tf-input:focus-visible,.tf-select:focus-visible{outline:3px solid var(--focus);outline-offset:1px}
.tf-error{margin:0 0 14px;color:var(--stop);font-weight:600}
.tf-ok{margin:0 0 14px;color:var(--go);font-weight:600}
.tf-link{padding:6px 0;background:none;border:0;color:var(--ink);text-decoration:underline;font:inherit;cursor:pointer}
.tf-link.is-danger,.tf-link.is-armed{color:var(--stop)}
.tf-link.is-armed{font-weight:600}
.tf-stack{display:grid;gap:10px;margin-top:8px}
.tf-panel{padding:18px;background:var(--sheet);border:2px solid var(--ink);border-radius:4px}
.tf-panel-title{margin:0 0 6px;font:700 1.3rem/1.1 'Barlow Condensed',system-ui,sans-serif}
.tf-panel .tf-hint{margin-bottom:14px}
.tf-divider{border:0;border-top:2px solid var(--rule);margin:26px 0}
.tf-check-block{display:flex;gap:12px;align-items:flex-start;cursor:pointer;margin-bottom:6px}
.tf-check-block input{width:22px;height:22px;margin:2px 0 0;flex-shrink:0;accent-color:#15314A}

.tf-detail-head{display:flex;gap:16px;align-items:flex-start;margin:12px 0 16px}
.tf-detail-head h2{margin:0 0 4px;font:700 2rem/1.02 'Barlow Condensed',system-ui,sans-serif}
.tf-detail-meta{margin:0;color:var(--ink-soft);font-size:.95rem;line-height:1.35}
.tf-tabs{margin:26px 0 14px}

.tf-board{list-style:none;margin:0;padding:0;background:var(--sheet);border:2px solid var(--ink);border-radius:4px}
.tf-board li{display:grid;grid-template-columns:2.4rem 1fr auto;gap:12px;align-items:center;padding:10px 14px}
.tf-board li+li{border-top:1px solid var(--rule)}
.tf-board li.is-me{background:#E1EBE4}
.tf-rank{font:700 1.25rem 'Barlow Condensed',system-ui,sans-serif;text-align:center;font-variant-numeric:tabular-nums}
.tf-board-main{min-width:0}
.tf-board-name{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tf-board-bar{display:block;height:5px;margin-top:6px;background:#D5DDD8;border-radius:3px;overflow:hidden}
.tf-board-bar span{display:block;height:100%;background:var(--go)}
.tf-board-score{font-size:.95rem;color:var(--ink-soft);font-variant-numeric:tabular-nums;white-space:nowrap}

.tf-cardlist{list-style:none;margin:0;padding:0;background:var(--sheet);border:2px solid var(--ink);border-radius:4px}
.tf-cardlist li+li{border-top:1px solid var(--rule)}
.tf-cardrow{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:2px 16px;width:100%;padding:10px 14px;background:none;border:0;color:var(--ink);font:inherit;text-align:left}
button.tf-cardrow{cursor:pointer}
button.tf-cardrow:hover{background:#EEF2EF}
.tf-cardrow .en{font-weight:600}
.tf-cardrow .cz{color:var(--ink-soft)}
.tf-edit-hint{font-size:.85rem;color:var(--ink-soft);text-decoration:underline}

.tf-login{max-width:440px}
.tf-login .tf-hero p{margin-bottom:22px}
.tf-footer{margin-top:30px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}
.tf-footer .tf-version{margin:0}
.tf-whoami{margin:0;font-size:.9rem;color:var(--ink-soft);overflow-wrap:anywhere}
`;


/* ------------------------------------------------------------------ */
/*  SMALL COMPONENTS                                                   */
/* ------------------------------------------------------------------ */

function Bubble({ code, count }) {
  return (
    <svg width="58" height="58" viewBox="0 0 58 58" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="29" cy="29" r="27" fill="#F7F8F4" stroke="#15314A" strokeWidth="2" />
      <line x1="2" y1="29" x2="56" y2="29" stroke="#15314A" strokeWidth="1.5" />
      <text x="29" y="23" textAnchor="middle" fontFamily="'Barlow Condensed', sans-serif" fontWeight="700" fontSize="15" fill="#15314A">{code}</text>
      <text x="29" y="45" textAnchor="middle" fontFamily="'Barlow Condensed', sans-serif" fontWeight="600" fontSize="13" fill="#15314A">{count}</text>
    </svg>
  );
}

function English({ card }) {
  return (
    <>
      <p className={`tf-term ${sizeClass(card.en)}`} lang="en">{card.en}</p>
      <div className="tf-pron">
        {card.ipa && <span className="tf-ipa">{card.ipa}</span>}
        <button
          type="button"
          className="tf-speak"
          aria-label="Přehrát výslovnost"
          onClick={(e) => { e.stopPropagation(); speak(card.en); }}
        >
          <Volume2 size={18} />
        </button>
      </div>
    </>
  );
}

function Czech({ card }) {
  return <p className={`tf-term ${sizeClass(card.cz)}`} lang="cs">{card.cz}</p>;
}

function TitleBlock({ card, deck, lang }) {
  return (
    <div className="tf-titleblock">
      <span>{card.tag || "Vlastní"}</span>
      <span className="tf-tb-num">{deck.code} {String(card.num).padStart(3, "0")}/{deck.cards.length}</span>
      <span className="tf-tb-lang">{lang}</span>
    </div>
  );
}

/*
  Flip fix: every new card gets a new React key, so it mounts face-up with no
  flip-back animation, and its back (the translation) is not rendered until flipped.
*/
function CardView({ card, deck, direction, flipped, revealed, onFlip }) {
  const enFirst = direction === "en-cz";
  return (
    <div
      className="tf-scene"
      role="button"
      tabIndex={0}
      aria-label={flipped ? "Otočit kartu zpět" : "Otočit kartu"}
      onClick={onFlip}
    >
      <div className={`tf-inner${flipped ? " is-flipped" : ""}`}>
        <div className="tf-face tf-face-front" aria-hidden={flipped}>
          <div className="tf-body">
            {enFirst ? <English card={card} /> : <Czech card={card} />}
          </div>
          <TitleBlock card={card} deck={deck} lang={enFirst ? "EN" : "CZ"} />
        </div>
        <div className="tf-face tf-face-back" aria-hidden={!flipped}>
          {revealed && (
            <>
              <div className="tf-body">
                {enFirst ? (
                  <>
                    <Czech card={card} />
                    <p className="tf-echo" lang="en">{card.en}</p>
                  </>
                ) : (
                  <English card={card} />
                )}
              </div>
              <TitleBlock card={card} deck={deck} lang={enFirst ? "CZ" : "EN"} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function deckSubtitle(view) {
  if (view.kind !== "custom") return null;
  if (view.isMine) return view.shared ? "Tvůj balíček, sdílený s ostatními" : "Tvůj balíček, vidíš ho jen ty";
  return `Sdílí ${view.ownerName || "jiný uživatel"}`;
}

function DeckRow({ view, progress, onOpen }) {
  const all = view.cards.length;
  const known = view.cards.filter((c) => progress[c.id] === 1).length;
  const sub = deckSubtitle(view);
  return (
    <button type="button" className="tf-deck" onClick={onOpen}>
      <Bubble code={view.code} count={all} />
      <span className="tf-deck-text">
        <span className="tf-deck-name">{view.name}</span>
        {view.desc && <span className="tf-deck-desc">{view.desc}</span>}
        {sub && <span className="tf-deck-owner">{sub}</span>}
        <span className="tf-meter"><span style={{ width: all ? `${(known / all) * 100}%` : "0%" }} /></span>
        <span className="tf-deck-known">{all ? `Umím ${known} z ${all}` : "Zatím bez kartiček"}</span>
      </span>
    </button>
  );
}

function ConfirmButton({ className, label, confirmLabel, onConfirm }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`${className}${armed ? " is-armed" : ""}`}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setArmed(false), 3500);
          return;
        }
        clearTimeout(timer.current);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

function BackNav({ label, onClick }) {
  return (
    <button type="button" className="tf-nav" onClick={onClick}>
      <ArrowLeft size={18} /> {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  LOGIN                                                              */
/* ------------------------------------------------------------------ */

function LoginScreen() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const lastSubmit = useRef(0);

  const switchMode = (next) => {
    setMode(next);
    setError("");
    setInfo("");
    setPassword("");
    setPassword2("");
    setInvite("");
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setInfo("");

    // light throttle so a mistyped invite code can't be hammered against Firestore
    const now = Date.now();
    if (now - lastSubmit.current < 1200) return;
    lastSubmit.current = now;

    const mail = email.trim();
    if (!mail) { setError("Vyplň e-mail."); return; }

    if (mode === "reset") {
      setBusy(true);
      try {
        await sendPasswordResetEmail(auth, mail);
        setInfo("Pokud účet s tímto e-mailem existuje, poslali jsme na něj odkaz pro nastavení hesla. Zkontroluj i složku se spamem.");
      } catch (err) {
        setError(authErrorText(err));
      }
      setBusy(false);
      return;
    }

    if (!password) { setError("Vyplň heslo."); return; }

    if (mode === "login") {
      setBusy(true);
      try {
        await signInWithEmailAndPassword(auth, mail, password);
      } catch (err) {
        setError(authErrorText(err));
      }
      setBusy(false);
      return;
    }

    // mode === "register"
    if (password.length < 6) { setError("Heslo musí mít aspoň 6 znaků."); return; }
    if (password !== password2) { setError("Hesla se neshodují."); return; }
    if (!invite.trim()) { setError("Vyplň zvací kód."); return; }
    setBusy(true);
    try {
      const ok = await checkInviteCode(invite);
      if (!ok) { setError("Neplatný zvací kód."); setBusy(false); return; }
      await createUserWithEmailAndPassword(auth, mail, password);
    } catch (err) {
      if (err && err.message === "invite-not-configured") {
        setError("Registrace teď není dostupná. Zkus to prosím později.");
      } else {
        setError(authErrorText(err));
      }
    }
    setBusy(false);
  };

  const titles = {
    login: "Přihlas se a tvůj pokrok se bude ukládat na všech tvých zařízeních.",
    reset: "Pošleme ti e-mail s odkazem, přes který si nastavíš nové heslo.",
    register: "Vytvoř si účet zvacím kódem, který jsi dostal od kolegy.",
  };
  const buttonLabels = {
    login: "Přihlásit se",
    reset: "Poslat odkaz",
    register: "Vytvořit účet",
  };

  return (
    <div className="tf-shell tf-login">
      <header className="tf-hero">
        <h1>Turbine English</h1>
        <p>{titles[mode]}</p>
      </header>
      <form onSubmit={submit} noValidate>
        <label className="tf-field">
          <span className="tf-label">E-mail</span>
          <input className="tf-input" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== "reset" && (
          <label className="tf-field">
            <span className="tf-label">Heslo</span>
            <input
              className="tf-input"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {mode === "register" && (
          <>
            <label className="tf-field">
              <span className="tf-label">Heslo znovu</span>
              <input className="tf-input" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
            </label>
            <label className="tf-field">
              <span className="tf-label">Zvací kód</span>
              <input className="tf-input" value={invite} onChange={(e) => setInvite(e.target.value)} />
              <span className="tf-hint">Kód dostaneš od kolegy, který aplikaci používá.</span>
            </label>
          </>
        )}
        {error && <p className="tf-error" role="alert">{error}</p>}
        {info && <p className="tf-ok" role="status">{info}</p>}
        <button type="submit" className="tf-btn tf-btn-flip" style={{ width: "100%" }} disabled={busy}>
          {busy ? "Chvilku…" : buttonLabels[mode]}
        </button>
      </form>
      <div className="tf-stack">
        {mode === "login" && (
          <>
            <button type="button" className="tf-link" onClick={() => switchMode("reset")}>Zapomenuté heslo</button>
            <button type="button" className="tf-link" onClick={() => switchMode("register")}>Nemáš účet? Vytvořit účet</button>
          </>
        )}
        {mode !== "login" && (
          <button type="button" className="tf-link" onClick={() => switchMode("login")}>Zpět na přihlášení</button>
        )}
      </div>
      <p className="tf-version">Verze {APP_VERSION}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LEADERBOARD                                                        */
/* ------------------------------------------------------------------ */

function ConsentPanel({ initialName, onConfirm }) {
  const [name, setName] = useState(initialName || "");
  const [err, setErr] = useState("");
  return (
    <div className="tf-panel">
      <p className="tf-panel-title">Soutěž s ostatními</p>
      <p className="tf-hint">
        V žebříčku uvidí ostatní přihlášení uživatelé tvoje jméno a kolik karet v balíčku umíš.
        Souhlas můžeš kdykoli zrušit v nastavení účtu a tvoje výsledky ze žebříčků zmizí.
      </p>
      <label className="tf-field">
        <span className="tf-label">Jméno v žebříčku</span>
        <input className="tf-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      {err && <p className="tf-error">{err}</p>}
      <button
        type="button"
        className="tf-btn tf-btn-flip"
        style={{ width: "100%" }}
        onClick={() => {
          const n = name.trim();
          if (!n) { setErr("Vyplň jméno, pod kterým tě ostatní uvidí."); return; }
          onConfirm(n);
        }}
      >
        Souhlasím, zapoj mě do žebříčku
      </button>
    </div>
  );
}

function Leaderboard({ entries, uid, total, error }) {
  if (error) return <p className="tf-empty">Žebříček se nepodařilo načíst. Zkontroluj připojení.</p>;
  if (!entries.length) return <p className="tf-empty">Zatím tu nikdo není. Odpověz na pár kartiček a budeš v žebříčku první.</p>;
  const sorted = [...entries].sort((a, b) => (b.known - a.known) || (a.displayName || "").localeCompare(b.displayName || "", "cs"));
  return (
    <ol className="tf-board" aria-label="Žebříček">
      {sorted.map((e) => {
        const rank = 1 + sorted.filter((x) => x.known > e.known).length;
        const t = total || e.total || 1;
        const me = e.uid === uid;
        return (
          <li key={e.uid} className={me ? "is-me" : ""}>
            <span className="tf-rank">{rank}.</span>
            <span className="tf-board-main">
              <span className="tf-board-name">
                {e.displayName || "Bez jména"}
                {me && <span className="tf-badge">ty</span>}
              </span>
              <span className="tf-board-bar"><span style={{ width: `${Math.min(100, (e.known / t) * 100)}%` }} /></span>
            </span>
            <span className="tf-board-score">{Math.min(e.known, t)} / {t}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/*  EDITORS                                                            */
/* ------------------------------------------------------------------ */

function CardEditor({ initial, deckOptions, onSave, onDelete, onClose }) {
  const card = initial.card;
  const editing = !!card;
  const [deckId, setDeckId] = useState(initial.deckId || (deckOptions[0] && deckOptions[0].id) || "");
  const [en, setEn] = useState(card ? card.en : "");
  const [cz, setCz] = useState(card ? card.cz : "");
  const [ipa, setIpa] = useState(card ? card.ipa || "" : "");
  const [tag, setTag] = useState(card ? card.tag || "" : "");
  const [note, setNote] = useState(card ? card.note || "" : "");
  const [example, setExample] = useState(card ? card.example || "" : "");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");
  const enRef = useRef(null);
  const target = deckOptions.find((d) => d.id === deckId);

  const save = (another) => {
    const e = en.trim();
    const c = cz.trim();
    if (!deckId) { setErr("Nejdřív si vytvoř balíček, nebo vyber základní."); return; }
    if (!e || !c) { setErr("Vyplň anglickou i českou stranu."); return; }
    onSave({ deckId, rawId: card ? card.rawId : null, en: e, cz: c, ipa: ipa.trim(), tag: tag.trim(), note: note.trim(), example: example.trim() }, another);
    if (another) {
      setEn(""); setCz(""); setIpa(""); setNote(""); setExample(""); setErr("");
      setSaved(`Uloženo: ${e}`);
      if (enRef.current) enRef.current.focus();
    }
  };

  return (
    <div className="tf-shell">
      <BackNav label="Zpět" onClick={onClose} />
      <h2 className="tf-page-title">{editing ? "Upravit kartičku" : "Nová kartička"}</h2>

      {!editing && (
        <label className="tf-field">
          <span className="tf-label">Balíček</span>
          <select className="tf-select" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            {deckOptions.map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.kind === "builtin" ? " (základní)" : ""}</option>
            ))}
          </select>
          {target && target.kind === "builtin" && (
            <span className="tf-hint">Kartičky přidané do základního balíčku uvidíš jen ty.</span>
          )}
          {target && target.kind === "custom" && target.shared && (
            <span className="tf-hint">Balíček je sdílený, kartičku uvidí i ostatní.</span>
          )}
        </label>
      )}

      <label className="tf-field">
        <span className="tf-label">Anglicky</span>
        <input ref={enRef} className="tf-input" lang="en" value={en} maxLength={140} onChange={(e) => setEn(e.target.value)} placeholder="např. to commission the turbine" />
      </label>
      <label className="tf-field">
        <span className="tf-label">Česky</span>
        <input className="tf-input" lang="cs" value={cz} maxLength={140} onChange={(e) => setCz(e.target.value)} placeholder="např. uvést turbínu do provozu" />
      </label>
      <label className="tf-field">
        <span className="tf-label">Výslovnost (nepovinné)</span>
        <input className="tf-input" value={ipa} maxLength={140} onChange={(e) => setIpa(e.target.value)} placeholder="/kəˈmɪʃn/" />
        <span className="tf-hint">Když ji nevyplníš, anglickou stranu si pořád můžeš přehrát tlačítkem reproduktoru.</span>
      </label>
      <label className="tf-field">
        <span className="tf-label">Kategorie (nepovinné)</span>
        <input className="tf-input" value={tag} maxLength={40} onChange={(e) => setTag(e.target.value)} placeholder="Vlastní" />
      </label>
      <label className="tf-field">
        <span className="tf-label">Vysvětlení (nepovinné)</span>
        <textarea className="tf-input tf-textarea" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Stručné vysvětlení, co termín znamená" />
      </label>
      <label className="tf-field">
        <span className="tf-label">Příklad použití ve větě (nepovinné)</span>
        <textarea className="tf-input tf-textarea" value={example} maxLength={300} onChange={(e) => setExample(e.target.value)} placeholder="Např. We need to commission the turbine next week." />
      </label>

      {err && <p className="tf-error" role="alert">{err}</p>}
      {saved && <p className="tf-ok" role="status">{saved}</p>}

      <div className="tf-done-actions">
        <button type="button" className="tf-btn tf-btn-flip" onClick={() => save(false)}>Uložit kartičku</button>
        {!editing && (
          <button type="button" className="tf-btn tf-btn-ghost" onClick={() => save(true)}>Uložit a přidat další</button>
        )}
      </div>
      {editing && (
        <div className="tf-stack">
          <ConfirmButton className="tf-link is-danger" label="Smazat kartičku" confirmLabel="Klikni znovu a kartička se smaže" onConfirm={onDelete} />
        </div>
      )}
    </div>
  );
}

function DeckEditor({ deck, onSave, onDelete, onClose }) {
  const editing = !!deck;
  const [name, setName] = useState(deck ? deck.name : "");
  const [desc, setDesc] = useState(deck ? deck.desc : "");
  const [shared, setShared] = useState(deck ? !!deck.shared : false);
  const [err, setErr] = useState("");

  return (
    <div className="tf-shell">
      <BackNav label="Zpět" onClick={onClose} />
      <h2 className="tf-page-title">{editing ? "Upravit balíček" : "Nový balíček"}</h2>
      <label className="tf-field">
        <span className="tf-label">Název</span>
        <input className="tf-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="např. Commissioning" />
      </label>
      <label className="tf-field">
        <span className="tf-label">Popis (nepovinné)</span>
        <input className="tf-input" value={desc} maxLength={140} onChange={(e) => setDesc(e.target.value)} placeholder="K čemu balíček slouží" />
      </label>
      <label className="tf-check-block">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        <span>
          <span className="tf-label">Sdílet s ostatními uživateli</span>
          <span className="tf-hint" style={{ display: "block" }}>
            Balíček uvidí a můžou procvičovat všichni přihlášení uživatelé. Upravovat ho můžeš jen ty.
          </span>
        </span>
      </label>
      {err && <p className="tf-error" role="alert">{err}</p>}
      <div className="tf-done-actions" style={{ marginTop: 18 }}>
        <button
          type="button"
          className="tf-btn tf-btn-flip"
          onClick={() => {
            const n = name.trim();
            if (!n) { setErr("Vyplň název balíčku."); return; }
            onSave({ name: n, desc: desc.trim(), shared });
          }}
        >
          {editing ? "Uložit změny" : "Vytvořit balíček"}
        </button>
      </div>
      {editing && (
        <div className="tf-stack">
          <ConfirmButton className="tf-link is-danger" label="Smazat balíček i s kartičkami" confirmLabel="Klikni znovu a balíček se nevratně smaže" onConfirm={onDelete} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ACCOUNT                                                            */
/* ------------------------------------------------------------------ */

function AccountScreen({ email, displayName, optIn, onSaveName, onSetOptIn, onResetProgress, onLogout, onClose }) {
  const [name, setName] = useState(displayName || "");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const flash = (text) => { setErr(""); setMsg(text); };

  return (
    <div className="tf-shell">
      <BackNav label="Balíčky" onClick={onClose} />
      <h2 className="tf-page-title">Účet</h2>
      <p className="tf-whoami">Přihlášen jako {email}</p>

      <hr className="tf-divider" />

      <label className="tf-field">
        <span className="tf-label">Jméno</span>
        <input className="tf-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <span className="tf-hint">Uvidí ho ostatní v žebříčku a u balíčků, které sdílíš.</span>
      </label>
      <button
        type="button"
        className="tf-btn tf-btn-ghost"
        style={{ width: "100%" }}
        onClick={() => {
          const n = name.trim();
          if (!n) { setMsg(""); setErr("Jméno nesmí být prázdné."); return; }
          onSaveName(n);
          flash("Jméno uloženo.");
        }}
      >
        Uložit jméno
      </button>

      <hr className="tf-divider" />

      <label className="tf-check-block">
        <input
          type="checkbox"
          checked={optIn}
          onChange={(e) => {
            if (e.target.checked) {
              const n = name.trim();
              if (!n) { setMsg(""); setErr("Nejdřív vyplň jméno, pod kterým tě ostatní uvidí."); return; }
              onSetOptIn(true, n);
              flash("Jsi zapojený do žebříčků.");
            } else {
              onSetOptIn(false);
              flash("Souhlas zrušen, tvoje výsledky ze žebříčků mizí.");
            }
          }}
        />
        <span>
          <span className="tf-label">Zobrazovat mě v žebříčcích</span>
          <span className="tf-hint" style={{ display: "block" }}>
            Ostatní přihlášení uživatelé uvidí tvoje jméno a kolik karet v jednotlivých balíčcích umíš.
            Když souhlas zrušíš, tvoje výsledky ze žebříčků zmizí.
          </span>
        </span>
      </label>

      {err && <p className="tf-error" role="alert" style={{ marginTop: 14 }}>{err}</p>}
      {msg && <p className="tf-ok" role="status" style={{ marginTop: 14 }}>{msg}</p>}

      <hr className="tf-divider" />

      <div className="tf-stack">
        <button
          type="button"
          className="tf-link"
          style={{ textAlign: "left" }}
          onClick={async () => {
            try {
              await sendPasswordResetEmail(auth, email);
              flash("Poslali jsme ti e-mail s odkazem pro změnu hesla. Zkontroluj i spam.");
            } catch (e) {
              setMsg(""); setErr(authErrorText(e));
            }
          }}
        >
          Poslat e-mail pro změnu hesla
        </button>
        <ConfirmButton className="tf-link is-danger" label="Vymazat pokrok ve všech balíčcích" confirmLabel="Klikni znovu a pokrok se vymaže" onConfirm={() => { onResetProgress(); flash("Pokrok vymazán."); }} />
        <button type="button" className="tf-link" style={{ textAlign: "left" }} onClick={onLogout}>Odhlásit se</button>
      </div>
      <p className="tf-version" style={{ marginTop: 26 }}>Verze {APP_VERSION}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  APP                                                                */
/* ------------------------------------------------------------------ */

const EMPTY_USER_DATA = { displayName: "", leaderboardOptIn: false, extras: {} };

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState(null);
  const [dataReady, setDataReady] = useState(false);
  const [progress, setProgress] = useState({});
  const [userData, setUserData] = useState(EMPTY_USER_DATA);
  const [myDecks, setMyDecks] = useState([]);
  const [sharedDecks, setSharedDecks] = useState([]);
  const [direction, setDirection] = useState(() => {
    try { return localStorage.getItem(DIR_KEY) || "en-cz"; } catch (e) { return "en-cz"; }
  });
  const [accent, setAccent] = useState(speechSettings.accent);
  const [rate, setRate] = useState(speechSettings.rate);
  const [voicePreview, setVoicePreview] = useState("idle");
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  const [syncError, setSyncError] = useState(false);

  const [screen, setScreen] = useState("home");
  const [openDeckId, setOpenDeckId] = useState(null);
  const [deckTab, setDeckTab] = useState("board");
  const [onlyUnknown, setOnlyUnknown] = useState(false);
  const [board, setBoard] = useState([]);
  const [boardError, setBoardError] = useState(false);
  const [cardEdit, setCardEdit] = useState(null);
  const [deckEdit, setDeckEdit] = useState(null);

  const [session, setSession] = useState(null);
  const [flipped, setFlipped] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  const lockUntil = useRef(0);
  const dirtyRef = useRef(new Set());
  const flushTimer = useRef(null);
  const initDoneRef = useRef(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const userDataRef = useRef(userData);
  userDataRef.current = userData;
  const userRef = useRef(user);
  userRef.current = user;

  const uid = user ? user.uid : null;

  /* ---------- deck views ---------- */
  const deckViews = useMemo(() => {
    const views = [];
    const extras = userData.extras || {};
    Object.values(DECKS).forEach((d) => {
      const extraCards = (extras[d.id] || []).map((c, i) => ({
        ...c, rawId: c.id, id: `x:${d.id}:${c.id}`, deckId: d.id, personal: true, num: d.cards.length + i + 1,
      }));
      views.push({
        id: d.id, kind: "builtin", code: d.code, name: d.name, desc: d.desc,
        baseCards: d.cards, cards: [...d.cards, ...extraCards], canAddCards: true, isMine: false,
      });
    });
    const custom = (dk, isMine) => {
      const cards = (dk.cards || []).map((c, i) => ({ ...c, rawId: c.id, id: `d:${dk.id}:${c.id}`, deckId: dk.id, num: i + 1 }));
      return {
        id: dk.id, kind: "custom", code: deckCode(dk.name), name: dk.name || "Bez názvu", desc: dk.desc || "",
        shared: !!dk.shared, ownerId: dk.ownerId, ownerName: dk.ownerName || "",
        baseCards: cards, cards, canAddCards: isMine, isMine,
      };
    };
    myDecks.forEach((dk) => views.push(custom(dk, true)));
    sharedDecks.filter((dk) => dk.ownerId !== uid).forEach((dk) => views.push(custom(dk, false)));
    return views;
  }, [userData.extras, myDecks, sharedDecks, uid]);

  const deckById = useMemo(() => Object.fromEntries(deckViews.map((v) => [v.id, v])), [deckViews]);
  const cardsById = useMemo(() => {
    const m = {};
    deckViews.forEach((v) => v.cards.forEach((c) => { m[c.id] = c; }));
    return m;
  }, [deckViews]);
  const deckByIdRef = useRef(deckById);
  deckByIdRef.current = deckById;
  const cardsByIdRef = useRef(cardsById);
  cardsByIdRef.current = cardsById;

  /* ---------- auth + connectivity ---------- */
  useEffect(() => onAuthStateChanged(auth, (u) => {
    setUser(u ? { uid: u.uid, email: u.email || "" } : null);
    setAuthReady(true);
  }), []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  /* ---------- cloud writes ---------- */
  const writeBoardEntry = (deckId, nameOverride) => {
    const u = userRef.current;
    const view = deckByIdRef.current[deckId];
    if (!u || !view || !view.baseCards.length) return;
    const p = progressRef.current;
    const known = view.baseCards.filter((c) => p[c.id] === 1).length;
    setDoc(doc(db, "leaderboard", `${deckId}__${u.uid}`), {
      deckId,
      uid: u.uid,
      displayName: nameOverride || userDataRef.current.displayName || "Bez jména",
      known,
      total: view.baseCards.length,
      updatedAt: serverTimestamp(),
    }).catch((e) => console.error("Žebříček:", e));
  };

  const flushNow = () => {
    clearTimeout(flushTimer.current);
    const u = userRef.current;
    const keys = [...dirtyRef.current];
    if (!u || !keys.length) return;
    dirtyRef.current = new Set();
    const patch = {};
    keys.forEach((k) => { patch[k] = progressRef.current[k] === 1 ? 1 : 0; });
    setDoc(doc(db, "users", u.uid), { progress: patch, updatedAt: serverTimestamp() }, { merge: true })
      .then(() => setSyncError(false))
      .catch((e) => { console.error("Synchronizace:", e); setSyncError(true); });
    if (userDataRef.current.leaderboardOptIn) {
      const decks = new Set(keys.map((k) => cardsByIdRef.current[k] && cardsByIdRef.current[k].deckId).filter(Boolean));
      decks.forEach((id) => writeBoardEntry(id));
    }
  };
  const flushRef = useRef(flushNow);
  flushRef.current = flushNow;

  const scheduleFlush = () => {
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flushRef.current(), 800);
  };

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushRef.current(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", onHide); };
  }, []);

  /* ---------- user document ---------- */
  useEffect(() => {
    if (!user) {
      initDoneRef.current = false;
      setDataReady(false);
      setProgress({});
      setUserData(EMPTY_USER_DATA);
      return undefined;
    }
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const fromServer = !(snap.metadata && snap.metadata.fromCache);

      if (!initDoneRef.current && (data || fromServer)) {
        initDoneRef.current = true;
        const legacy = readLegacyProgress();
        if (!data || legacy) {
          const merged = { ...((data && data.progress) || {}) };
          if (legacy) {
            Object.entries(legacy).forEach(([k, v]) => { if (v === 1 || merged[k] === undefined) merged[k] = v === 1 ? 1 : 0; });
          }
          const init = { progress: merged, updatedAt: serverTimestamp() };
          if (!data) {
            Object.assign(init, {
              displayName: (user.email || "").split("@")[0],
              leaderboardOptIn: false,
              extras: {},
              direction,
              createdAt: serverTimestamp(),
            });
          }
          setDoc(ref, init, { merge: true }).catch((e) => { console.error(e); setSyncError(true); });
          try { localStorage.setItem(LEGACY_DONE_KEY, "1"); } catch (e) { /* ignore */ }
        }
      }

      if (data) {
        const cloud = data.progress || {};
        const next = { ...cloud };
        dirtyRef.current.forEach((k) => { if (k in progressRef.current) next[k] = progressRef.current[k]; });
        progressRef.current = next;
        setProgress(next);
        setUserData({
          displayName: data.displayName || "",
          leaderboardOptIn: !!data.leaderboardOptIn,
          extras: data.extras || {},
        });
        if (data.direction === "en-cz" || data.direction === "cz-en") setDirection(data.direction);
      }
      if (data || fromServer) setDataReady(true);
    }, (e) => {
      console.error("Načtení účtu:", e);
      setSyncError(true);
      setDataReady(true);
    });
    return unsub;
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- decks ---------- */
  useEffect(() => {
    if (!user) { setMyDecks([]); setSharedDecks([]); return undefined; }
    const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "cs");
    const u1 = onSnapshot(
      query(collection(db, "decks"), where("ownerId", "==", user.uid)),
      (s) => setMyDecks(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byName)),
      (e) => console.error("Moje balíčky:", e)
    );
    const u2 = onSnapshot(
      query(collection(db, "decks"), where("shared", "==", true)),
      (s) => setSharedDecks(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byName)),
      (e) => console.error("Sdílené balíčky:", e)
    );
    return () => { u1(); u2(); };
  }, [user]);

  /* ---------- leaderboard of the open deck ---------- */
  useEffect(() => {
    if (!user || screen !== "deck" || !openDeckId) return undefined;
    setBoard([]);
    setBoardError(false);
    return onSnapshot(
      query(collection(db, "leaderboard"), where("deckId", "==", openDeckId)),
      (s) => setBoard(s.docs.map((d) => d.data())),
      (e) => { console.error("Žebříček:", e); setBoardError(true); }
    );
  }, [user, screen, openDeckId]);

  /* ---------- drop deleted cards from a running session ---------- */
  useEffect(() => {
    if (!session || (screen !== "study" && screen !== "done")) return;
    const queue = session.queue.filter((id) => cardsById[id]);
    if (queue.length !== session.queue.length) {
      setSession((s) => ({ ...s, queue }));
      if (!queue.length && screen === "study") setScreen("done");
    }
  }, [cardsById, session, screen]);

  /* ---------- actions ---------- */
  const changeDirection = (d) => {
    setDirection(d);
    try { localStorage.setItem(DIR_KEY, d); } catch (e) { /* ignore */ }
    if (uid) setDoc(doc(db, "users", uid), { direction: d }, { merge: true }).catch((e) => console.error(e));
  };

  const changeAccent = (a) => {
    speechSettings.accent = a;
    setAccent(a);
    saveSpeechSettings();
  };

  const changeRate = (r) => {
    speechSettings.rate = r;
    setRate(r);
    saveSpeechSettings();
  };

  const previewVoice = () => {
    setVoicePreview("playing");
    speak("This is what the pronunciation will sound like.");
    setTimeout(() => setVoicePreview("idle"), 2500);
  };

  const openDeck = (id) => {
    setOpenDeckId(id);
    setScreen("deck");
    window.scrollTo(0, 0);
  };

  const startSession = (deckId, ids) => {
    const view = deckById[deckId];
    if (!view) return;
    let pool = ids || view.cards.filter((c) => !onlyUnknown || progress[c.id] !== 1).map((c) => c.id);
    if (pool.length === 0) pool = view.cards.map((c) => c.id);
    if (pool.length === 0) return;
    setSession({ deckId, queue: shuffle(pool), total: pool.length, done: 0, missed: {}, step: 0 });
    setFlipped(false);
    setRevealed(false);
    setInfoOpen(false);
    lockUntil.current = Date.now() + 250;
    setScreen("study");
    window.scrollTo(0, 0);
  };

  const flip = () => {
    if (Date.now() < lockUntil.current) return;
    setFlipped((f) => !f);
    setRevealed(true);
  };

  const answer = (knew) => {
    if (!session || session.queue.length === 0 || !revealed) return;
    if (Date.now() < lockUntil.current) return;
    const [current, ...rest] = session.queue;
    let queue = rest;
    if (!knew) {
      queue = [...rest];
      const pos = Math.min(rest.length, 3 + Math.floor(Math.random() * 3));
      queue.splice(pos, 0, current);
    }
    const value = knew ? 1 : 0;
    progressRef.current = { ...progressRef.current, [current]: value };
    setProgress((p) => ({ ...p, [current]: value }));
    dirtyRef.current.add(current);
    scheduleFlush();
    setFlipped(false);
    setRevealed(false);
    setInfoOpen(false);
    lockUntil.current = Date.now() + 350;
    stopSpeech();
    setSession({
      ...session,
      queue,
      step: session.step + 1,
      done: knew ? session.done + 1 : session.done,
      missed: knew ? session.missed : { ...session.missed, [current]: true },
    });
    if (queue.length === 0) setScreen("done");
  };

  useEffect(() => {
    if (screen !== "study") return undefined;
    const onKey = (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const onButton = e.target && e.target.closest && e.target.closest("button");
      if (e.key === " " || e.key === "Enter") {
        if (onButton) return;
        e.preventDefault();
        flip();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        answer(true);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        answer(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const saveCard = ({ deckId, rawId, en, cz, ipa, tag, note, example }) => {
    const view = deckById[deckId];
    if (!view || !uid) return;
    const card = { id: rawId || newId(), en, cz, ipa: ipa || "", tag: tag || "", note: note || "", example: example || "" };
    const upsert = (list) => {
      const next = [...list];
      const i = next.findIndex((c) => c.id === card.id);
      if (i >= 0) next[i] = card; else next.push(card);
      return next;
    };
    if (view.kind === "builtin") {
      const list = upsert((userData.extras || {})[deckId] || []);
      setDoc(doc(db, "users", uid), { extras: { [deckId]: list } }, { merge: true }).catch((e) => { console.error(e); setSyncError(true); });
    } else {
      const raw = myDecks.find((d) => d.id === deckId);
      if (!raw) return;
      updateDoc(doc(db, "decks", deckId), { cards: upsert(raw.cards || []), updatedAt: serverTimestamp() }).catch((e) => { console.error(e); setSyncError(true); });
    }
  };

  const deleteCard = (card) => {
    const view = deckById[card.deckId];
    if (!view || !uid) return;
    if (view.kind === "builtin") {
      const list = ((userData.extras || {})[card.deckId] || []).filter((c) => c.id !== card.rawId);
      setDoc(doc(db, "users", uid), { extras: { [card.deckId]: list } }, { merge: true }).catch((e) => console.error(e));
    } else {
      const raw = myDecks.find((d) => d.id === card.deckId);
      if (!raw) return;
      updateDoc(doc(db, "decks", card.deckId), { cards: (raw.cards || []).filter((c) => c.id !== card.rawId), updatedAt: serverTimestamp() }).catch((e) => console.error(e));
    }
  };

  const saveDeck = (existing, { name, desc, shared }) => {
    if (!uid) return null;
    if (existing) {
      updateDoc(doc(db, "decks", existing.id), { name, desc, shared, updatedAt: serverTimestamp() }).catch((e) => { console.error(e); setSyncError(true); });
      return existing.id;
    }
    const ref = doc(collection(db, "decks"));
    setDoc(ref, {
      ownerId: uid,
      ownerName: userData.displayName || (user.email || "").split("@")[0],
      name,
      desc,
      shared,
      cards: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).catch((e) => { console.error(e); setSyncError(true); });
    return ref.id;
  };

  const deleteDeck = (deck) => {
    if (!uid) return;
    deleteDoc(doc(db, "decks", deck.id)).catch((e) => console.error(e));
    deleteDoc(doc(db, "leaderboard", `${deck.id}__${uid}`)).catch(() => { /* no entry */ });
  };

  const myBoardEntries = async () => {
    const s = await getDocs(query(collection(db, "leaderboard"), where("uid", "==", uid)));
    return s.docs;
  };

  const setOptIn = async (on, name) => {
    if (!uid) return;
    const userDoc = doc(db, "users", uid);
    if (on) {
      userDataRef.current = { ...userDataRef.current, leaderboardOptIn: true, displayName: name };
      setUserData((d) => ({ ...d, leaderboardOptIn: true, displayName: name }));
      setDoc(userDoc, { leaderboardOptIn: true, displayName: name }, { merge: true }).catch((e) => console.error(e));
      deckViews.forEach((v) => {
        if (v.baseCards.some((c) => progressRef.current[c.id] === 1)) writeBoardEntry(v.id, name);
      });
    } else {
      userDataRef.current = { ...userDataRef.current, leaderboardOptIn: false };
      setUserData((d) => ({ ...d, leaderboardOptIn: false }));
      setDoc(userDoc, { leaderboardOptIn: false }, { merge: true }).catch((e) => console.error(e));
      try {
        const entries = await myBoardEntries();
        entries.forEach((d) => deleteDoc(d.ref).catch((e) => console.error(e)));
      } catch (e) {
        console.error("Mazání ze žebříčku:", e);
      }
    }
  };

  const saveName = async (name) => {
    if (!uid) return;
    userDataRef.current = { ...userDataRef.current, displayName: name };
    setUserData((d) => ({ ...d, displayName: name }));
    setDoc(doc(db, "users", uid), { displayName: name }, { merge: true }).catch((e) => console.error(e));
    myDecks.forEach((d) => updateDoc(doc(db, "decks", d.id), { ownerName: name }).catch((e) => console.error(e)));
    if (userDataRef.current.leaderboardOptIn) {
      try {
        const entries = await myBoardEntries();
        entries.forEach((d) => setDoc(d.ref, { displayName: name }, { merge: true }).catch((e) => console.error(e)));
      } catch (e) {
        console.error(e);
      }
    }
  };

  const resetProgress = async () => {
    if (!uid) return;
    clearTimeout(flushTimer.current);
    dirtyRef.current = new Set();
    progressRef.current = {};
    setProgress({});
    updateDoc(doc(db, "users", uid), { progress: {}, updatedAt: serverTimestamp() }).catch((e) => console.error(e));
    if (userDataRef.current.leaderboardOptIn) {
      try {
        const entries = await myBoardEntries();
        entries.forEach((d) => setDoc(d.ref, { known: 0, updatedAt: serverTimestamp() }, { merge: true }).catch((e) => console.error(e)));
      } catch (e) {
        console.error(e);
      }
    }
  };

  const logout = async () => {
    flushRef.current();
    stopSpeech();
    setSession(null);
    setScreen("home");
    setOpenDeckId(null);
    try { await signOut(auth); } catch (e) { console.error(e); }
  };

  /* ---------------- render ---------------- */
  const shell = (content) => (
    <div className="tf-root">
      <style>{CSS}</style>
      {content}
    </div>
  );

  if (!authReady) return shell(<div className="tf-splash">Načítám…</div>);
  if (!user) return shell(<LoginScreen />);
  if (!dataReady) return shell(<div className="tf-splash">Načítám tvůj pokrok…</div>);

  const banners = (
    <>
      {!online && <p className="tf-banner">Jsi offline. Pokrok se uloží do cloudu, jakmile se připojíš.</p>}
      {online && syncError && <p className="tf-banner is-error">Něco se nepodařilo uložit do cloudu. Zkontroluj připojení a zkus aplikaci zavřít a znovu otevřít.</p>}
    </>
  );

  /* ---------- card editor ---------- */
  if (screen === "card" && cardEdit) {
    const deckOptions = deckViews.filter((v) => v.canAddCards);
    const close = () => { setCardEdit(null); setScreen(cardEdit.returnTo || "home"); window.scrollTo(0, 0); };
    return shell(
      <CardEditor
        key={cardEdit.card ? cardEdit.card.id : `new-${cardEdit.deckId || ""}`}
        initial={cardEdit}
        deckOptions={deckOptions}
        onSave={(data, another) => {
          saveCard(data);
          if (!another) {
            setOpenDeckId(data.deckId);
            if (!cardEdit.card) setDeckTab("cards");
            setCardEdit(null);
            setScreen("deck");
            window.scrollTo(0, 0);
          }
        }}
        onDelete={() => { deleteCard(cardEdit.card); close(); }}
        onClose={close}
      />
    );
  }

  /* ---------- deck editor ---------- */
  if (screen === "deckEdit") {
    const existing = deckEdit && deckEdit.deck;
    return shell(
      <DeckEditor
        key={existing ? existing.id : "new"}
        deck={existing}
        onSave={(data) => {
          const id = saveDeck(existing, data);
          setDeckEdit(null);
          if (id) { setOpenDeckId(id); setDeckTab(existing ? deckTab : "cards"); setScreen("deck"); } else setScreen("home");
          window.scrollTo(0, 0);
        }}
        onDelete={() => { deleteDeck(existing); setDeckEdit(null); setOpenDeckId(null); setScreen("home"); }}
        onClose={() => { setDeckEdit(null); setScreen(existing ? "deck" : "home"); }}
      />
    );
  }

  /* ---------- account ---------- */
  if (screen === "account") {
    return shell(
      <AccountScreen
        email={user.email}
        displayName={userData.displayName}
        optIn={userData.leaderboardOptIn}
        onSaveName={saveName}
        onSetOptIn={setOptIn}
        onResetProgress={resetProgress}
        onLogout={logout}
        onClose={() => setScreen("home")}
      />
    );
  }

  /* ---------- deck detail ---------- */
  if (screen === "deck") {
    const view = deckById[openDeckId];
    if (!view) {
      return shell(
        <div className="tf-shell">
          <BackNav label="Balíčky" onClick={() => setScreen("home")} />
          <p className="tf-empty" style={{ marginTop: 16 }}>Balíček se načítá, nebo už není dostupný.</p>
        </div>
      );
    }
    const all = view.cards.length;
    const known = view.cards.filter((c) => progress[c.id] === 1).length;
    const toLearn = all - known;
    const sub = deckSubtitle(view);
    const personalCount = view.cards.filter((c) => c.personal).length;
    return shell(
      <div className="tf-shell">
        <BackNav label="Balíčky" onClick={() => setScreen("home")} />
        {banners}
        <div className="tf-detail-head">
          <Bubble code={view.code} count={all} />
          <div>
            <h2>{view.name}</h2>
            {view.desc && <p className="tf-detail-meta">{view.desc}</p>}
            {sub && <p className="tf-detail-meta">{sub}</p>}
          </div>
        </div>

        <span className="tf-meter"><span style={{ width: all ? `${(known / all) * 100}%` : "0%" }} /></span>
        <p className="tf-deck-known" style={{ margin: "6px 0 16px" }}>
          {all ? `Umím ${known} z ${all}` : "Balíček je zatím prázdný."}
          {personalCount > 0 ? `, z toho ${personalCount} vlastních kartiček` : ""}
        </p>

        {all > 0 && (
          <>
            <label className="tf-check">
              <input type="checkbox" checked={onlyUnknown} onChange={(e) => setOnlyUnknown(e.target.checked)} />
              Jen karty, které ještě neumím{onlyUnknown ? ` (${toLearn || all})` : ""}
            </label>
            <button type="button" className="tf-btn tf-btn-flip" style={{ width: "100%" }} onClick={() => startSession(view.id)}>
              Procvičovat
            </button>
          </>
        )}

        {(view.canAddCards || view.isMine) && (
          <div className="tf-actions">
            {view.canAddCards && (
              <button type="button" className="tf-btn tf-btn-ghost" onClick={() => { setCardEdit({ deckId: view.id, card: null, returnTo: "deck" }); setScreen("card"); window.scrollTo(0, 0); }}>
                <Plus size={18} /> Přidat kartičku
              </button>
            )}
            {view.isMine && (
              <button type="button" className="tf-btn tf-btn-ghost" onClick={() => { setDeckEdit({ deck: view }); setScreen("deckEdit"); window.scrollTo(0, 0); }}>
                Upravit balíček
              </button>
            )}
          </div>
        )}

        <div className="tf-seg tf-tabs" role="radiogroup" aria-label="Zobrazit">
          <button type="button" role="radio" aria-checked={deckTab === "board"} onClick={() => setDeckTab("board")}>Žebříček</button>
          <button type="button" role="radio" aria-checked={deckTab === "cards"} onClick={() => setDeckTab("cards")}>Kartičky ({all})</button>
        </div>

        {deckTab === "board" && (
          <>
            {!userData.leaderboardOptIn && (
              <div style={{ marginBottom: 14 }}>
                <ConsentPanel initialName={userData.displayName} onConfirm={(n) => setOptIn(true, n)} />
              </div>
            )}
            {view.kind === "builtin" && (
              <p className="tf-hint" style={{ marginBottom: 10 }}>Do žebříčku se počítají jen základní kartičky, vlastní ne. Všichni tak mají stejné podmínky.</p>
            )}
            <Leaderboard entries={board} uid={uid} total={view.baseCards.length} error={boardError} />
          </>
        )}

        {deckTab === "cards" && (
          all === 0 ? (
            <p className="tf-empty">{view.canAddCards ? "Přidej první kartičku tlačítkem výše." : "Autor zatím nepřidal žádné kartičky."}</p>
          ) : (
            <ul className="tf-cardlist">
              {view.cards.map((c) => {
                const editable = c.personal || view.isMine;
                const inner = (
                  <>
                    <span className="en" lang="en">
                      {c.en}
                      {c.personal && <span className="tf-badge">vlastní</span>}
                    </span>
                    <span className="cz" lang="cs">{c.cz}</span>
                    {editable && <span className="tf-edit-hint">Upravit</span>}
                  </>
                );
                return (
                  <li key={c.id}>
                    {editable ? (
                      <button type="button" className="tf-cardrow" onClick={() => { setCardEdit({ deckId: c.deckId, card: c, returnTo: "deck" }); setScreen("card"); window.scrollTo(0, 0); }}>
                        {inner}
                      </button>
                    ) : (
                      <div className="tf-cardrow">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>
    );
  }

  /* ---------- done ---------- */
  if (screen === "done" && session) {
    const view = deckById[session.deckId];
    const missedIds = Object.keys(session.missed).filter((id) => cardsById[id]);
    return shell(
      <div className="tf-shell tf-done">
        <BackNav label="Balíček" onClick={() => (view ? openDeck(view.id) : setScreen("home"))} />
        <h2>Kolo dokončeno</h2>
        <p className="tf-done-lede">
          {view ? view.name : "Balíček"}: {session.total} karet, napoprvé {session.total - missedIds.length}
          {missedIds.length > 0 ? `, s opakováním ${missedIds.length}.` : ". Všechno napoprvé."}
        </p>
        {missedIds.length > 0 && (
          <ul className="tf-missed" aria-label="Karty, které šly napoprvé špatně">
            {missedIds.map((id) => {
              const c = cardsById[id];
              return (
                <li key={id}>
                  <span className="en" lang="en">{c.en}</span>
                  <span className="cz" lang="cs">{c.cz}</span>
                </li>
              );
            })}
          </ul>
        )}
        {view && (
          <div className="tf-done-actions">
            {missedIds.length > 0 && (
              <button type="button" className="tf-btn tf-btn-flip" onClick={() => startSession(view.id, missedIds)}>
                Procvičit znovu {missedIds.length} chybných
              </button>
            )}
            <button type="button" className="tf-btn tf-btn-ghost" onClick={() => startSession(view.id)}>
              Nové kolo celého balíčku
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ---------- study ---------- */
  if (screen === "study" && session) {
    const view = deckById[session.deckId];
    const card = cardsById[session.queue[0]];
    if (!view || !card) return shell(<div className="tf-splash">Načítám…</div>);
    const pct = (session.done / session.total) * 100;
    return shell(
      <div className="tf-shell">
        <div className="tf-studybar">
          <BackNav label="Balíček" onClick={() => { stopSpeech(); openDeck(view.id); }} />
          <span className="tf-count">Umím {session.done} z {session.total}</span>
          {(card.note || card.example) && (
            <button
              type="button"
              className={`tf-info-btn${infoOpen ? " is-active" : ""}`}
              onClick={(e) => { e.stopPropagation(); setInfoOpen((v) => !v); }}
              aria-pressed={infoOpen}
              title="Vysvětlení a příklad"
            >
              ⓘ Vysvětlení
            </button>
          )}
        </div>
        <div className="tf-progress" role="progressbar" aria-valuemin={0} aria-valuemax={session.total} aria-valuenow={session.done}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <CardView
          key={`${card.id}#${session.step}`}
          card={card}
          deck={view}
          direction={direction}
          flipped={flipped}
          revealed={revealed}
          onFlip={flip}
        />
        {infoOpen && (card.note || card.example) && (
          <div className="tf-info-panel" role="note">
            {card.note && <p className="tf-info-note">{card.note}</p>}
            {card.example && <p className="tf-info-example" lang="en">{card.example}</p>}
          </div>
        )}
        <div className="tf-controls">
          {!revealed ? (
            <button type="button" className="tf-btn tf-btn-flip" onClick={flip}>Otočit kartu</button>
          ) : (
            <>
              <button type="button" className="tf-btn tf-btn-no" onClick={() => answer(false)}>Neumím</button>
              <button type="button" className="tf-btn tf-btn-yes" onClick={() => answer(true)}>Umím</button>
            </>
          )}
        </div>
        <p className="tf-keys">Mezerník otočí kartu, šipka vlevo znamená neumím, šipka vpravo umím</p>
      </div>
    );
  }

  /* ---------- home ---------- */
  const builtin = deckViews.filter((v) => v.kind === "builtin");
  const mine = deckViews.filter((v) => v.kind === "custom" && v.isMine);
  const others = deckViews.filter((v) => v.kind === "custom" && !v.isMine);

  return shell(
    <div className="tf-shell">
      <header className="tf-hero">
        <h1>Turbine English</h1>
        <p>Kartičky EN–CZ pro práci u parních turbín a pro jednání se zákazníkem.</p>
      </header>
      {banners}

      <div className="tf-setting">
        <span className="tf-setting-label">Směr</span>
        <div className="tf-seg" role="radiogroup" aria-label="Směr překladu">
          <button type="button" role="radio" aria-checked={direction === "en-cz"} onClick={() => changeDirection("en-cz")}>EN → CZ</button>
          <button type="button" role="radio" aria-checked={direction === "cz-en"} onClick={() => changeDirection("cz-en")}>CZ → EN</button>
        </div>
      </div>

      <div className="tf-setting">
        <span className="tf-setting-label">Přízvuk</span>
        <div className="tf-seg" role="radiogroup" aria-label="Přízvuk výslovnosti">
          <button type="button" role="radio" aria-checked={accent === "us"} onClick={() => changeAccent("us")}>Americký</button>
          <button type="button" role="radio" aria-checked={accent === "uk"} onClick={() => changeAccent("uk")}>Britský</button>
        </div>
      </div>

      <div className="tf-setting">
        <span className="tf-setting-label">Rychlost</span>
        <div className="tf-seg" role="radiogroup" aria-label="Rychlost výslovnosti">
          <button type="button" role="radio" aria-checked={rate === 0.75} onClick={() => changeRate(0.75)}>Pomalu</button>
          <button type="button" role="radio" aria-checked={rate === 0.9} onClick={() => changeRate(0.9)}>Normálně</button>
          <button type="button" role="radio" aria-checked={rate === 1.05} onClick={() => changeRate(1.05)}>Rychleji</button>
        </div>
        <button type="button" className="tf-link" style={{ padding: "6px 0" }} onClick={previewVoice} disabled={voicePreview === "playing"}>
          {voicePreview === "playing" ? "Přehrávám…" : "Vyzkoušet hlas"}
        </button>
      </div>

      <div className="tf-actions">
        <button type="button" className="tf-btn tf-btn-flip" onClick={() => { setCardEdit({ deckId: null, card: null, returnTo: "home" }); setScreen("card"); window.scrollTo(0, 0); }}>
          <Plus size={18} /> Nová kartička
        </button>
        <button type="button" className="tf-btn tf-btn-ghost" onClick={() => { setDeckEdit({ deck: null }); setScreen("deckEdit"); window.scrollTo(0, 0); }}>
          <Plus size={18} /> Nový balíček
        </button>
      </div>

      <section className="tf-section">
        <h2 className="tf-section-title">Základní balíčky</h2>
        <div className="tf-decks">
          {builtin.map((v) => <DeckRow key={v.id} view={v} progress={progress} onOpen={() => openDeck(v.id)} />)}
        </div>
      </section>

      <section className="tf-section">
        <h2 className="tf-section-title">Moje balíčky</h2>
        {mine.length ? (
          <div className="tf-decks">
            {mine.map((v) => <DeckRow key={v.id} view={v} progress={progress} onOpen={() => openDeck(v.id)} />)}
          </div>
        ) : (
          <p className="tf-empty">Zatím žádný. Vytvoř si vlastní balíček a můžeš ho sdílet s kolegy.</p>
        )}
      </section>

      <section className="tf-section">
        <h2 className="tf-section-title">Sdílené od ostatních</h2>
        {others.length ? (
          <div className="tf-decks">
            {others.map((v) => <DeckRow key={v.id} view={v} progress={progress} onOpen={() => openDeck(v.id)} />)}
          </div>
        ) : (
          <p className="tf-empty">Tady se objeví balíčky, které s tebou sdílí ostatní uživatelé.</p>
        )}
      </section>

      <footer className="tf-footer">
        <p className="tf-whoami">{userData.displayName || user.email}</p>
        <button type="button" className="tf-link" onClick={() => { setScreen("account"); window.scrollTo(0, 0); }}>Účet a žebříček</button>
        <p className="tf-version">Verze {APP_VERSION}</p>
      </footer>
    </div>
  );
}

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

const APP_VERSION = "2.2";

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
    u.lang = "en-US";
    u.rate = 0.9;
    const voices = synth.getVoices();
    const voice = voices.find((v) => v.lang === "en-US") || voices.find((v) => v.lang && v.lang.startsWith("en"));
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

function buildDeck(prefix, groups) {
  const cards = [];
  groups.forEach(([tag, items]) => {
    items.forEach(([en, ipa, cz]) => {
      cards.push({ id: `${prefix}:${en}`, num: cards.length + 1, en, ipa, cz, tag, deckId: prefix });
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
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");
  const enRef = useRef(null);
  const target = deckOptions.find((d) => d.id === deckId);

  const save = (another) => {
    const e = en.trim();
    const c = cz.trim();
    if (!deckId) { setErr("Nejdřív si vytvoř balíček, nebo vyber základní."); return; }
    if (!e || !c) { setErr("Vyplň anglickou i českou stranu."); return; }
    onSave({ deckId, rawId: card ? card.rawId : null, en: e, cz: c, ipa: ipa.trim(), tag: tag.trim() }, another);
    if (another) {
      setEn(""); setCz(""); setIpa(""); setErr("");
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

  const saveCard = ({ deckId, rawId, en, cz, ipa, tag }) => {
    const view = deckById[deckId];
    if (!view || !uid) return;
    const card = { id: rawId || newId(), en, cz, ipa: ipa || "", tag: tag || "" };
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

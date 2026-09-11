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

const APP_VERSION = "2.1";

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

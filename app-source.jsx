import { useState, useEffect, useRef } from "react";
import { Volume2, ArrowLeft } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  DATA                                                               */
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
      cards.push({ id: `${prefix}:${en}`, num: cards.length + 1, en, ipa, cz, tag });
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

const CARD_BY_ID = {};
Object.values(DECKS).forEach((d) => d.cards.forEach((c) => { CARD_BY_ID[c.id] = c; }));

const STORAGE_KEY = "turbine-flashcards-v1";
const APP_VERSION = "1.0";

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */

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

function sizeClass(text) {
  if (text.length > 34) return "is-long";
  if (text.length > 22) return "is-mid";
  return "";
}

/* ------------------------------------------------------------------ */
/*  STYLES                                                             */
/* ------------------------------------------------------------------ */

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
`;

/* ------------------------------------------------------------------ */
/*  COMPONENTS                                                         */
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
        <span className="tf-ipa">{card.ipa}</span>
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
      <span>{card.tag}</span>
      <span className="tf-tb-num">{deck.code} {String(card.num).padStart(3, "0")}/{deck.cards.length}</span>
      <span className="tf-tb-lang">{lang}</span>
    </div>
  );
}

/*
  Oprava otáčení:
  - Každá nová karta dostane nový React `key`, takže se vytvoří jako čerstvý prvek
    rovnou lícem nahoru, bez animace zpětného otočení.
  - Rub (překlad) se do stránky vůbec nevykreslí, dokud kartu neotočíš.
  - Krátká pojistka po odpovědi zabrání tomu, aby rychlé dvojkliknutí hned otočilo novou kartu.
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

/* ------------------------------------------------------------------ */
/*  APP                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState({});
  const [direction, setDirection] = useState("en-cz");
  const [onlyUnknown, setOnlyUnknown] = useState(false);
  const [screen, setScreen] = useState("decks");
  const [session, setSession] = useState(null);
  const [flipped, setFlipped] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const lockUntil = useRef(0);
  const saveTimer = useRef(null);
  const resetTimer = useRef(null);

  // Load saved progress (stored on this device)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.progress) setProgress(data.progress);
        if (data.direction) setDirection(data.direction);
      }
    } catch (e) {
      /* nothing saved yet */
    }
    setLoaded(true);
  }, []);

  // Save progress (debounced)
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ progress, direction }));
      } catch (e) {
        console.error("Uložení pokroku selhalo:", e);
      }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [progress, direction, loaded]);

  const stopSpeech = () => {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  };

  const startSession = (deckId, ids) => {
    const deck = DECKS[deckId];
    let pool = ids || deck.cards.filter((c) => !onlyUnknown || progress[c.id] !== 1).map((c) => c.id);
    if (pool.length === 0) pool = deck.cards.map((c) => c.id);
    setSession({ deckId, queue: shuffle(pool), total: pool.length, done: 0, missed: {}, step: 0 });
    setFlipped(false);
    setRevealed(false);
    lockUntil.current = Date.now() + 250;
    setScreen("study");
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
    const next = {
      ...session,
      queue,
      step: session.step + 1,
      done: knew ? session.done + 1 : session.done,
      missed: knew ? session.missed : { ...session.missed, [current]: true },
    };
    setProgress((p) => ({ ...p, [current]: knew ? 1 : 0 }));
    // New card starts face-up with its back not rendered at all
    setFlipped(false);
    setRevealed(false);
    lockUntil.current = Date.now() + 350;
    stopSpeech();
    setSession(next);
    if (queue.length === 0) setScreen("done");
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (screen !== "study") return;
    const onKey = (e) => {
      const onButton = e.target && e.target.closest && e.target.closest("button");
      if (e.key === " " || e.key === "Enter") {
        if (onButton) return; // let the focused button do its own thing
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

  const handleReset = () => {
    if (!resetArmed) {
      setResetArmed(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setResetArmed(false), 3500);
      return;
    }
    clearTimeout(resetTimer.current);
    setProgress({});
    setResetArmed(false);
  };

  /* ---------------- Decks screen ---------------- */
  if (screen === "decks" || !session) {
    return (
      <div className="tf-root">
        <style>{CSS}</style>
        <div className="tf-shell">
          <header className="tf-hero">
            <h1>Turbine English</h1>
            <p>Kartičky EN–CZ pro práci u parních turbín a pro jednání se zákazníkem.</p>
          </header>

          <div className="tf-setting">
            <span className="tf-setting-label">Směr</span>
            <div className="tf-seg" role="radiogroup" aria-label="Směr překladu">
              <button type="button" role="radio" aria-checked={direction === "en-cz"} onClick={() => setDirection("en-cz")}>EN → CZ</button>
              <button type="button" role="radio" aria-checked={direction === "cz-en"} onClick={() => setDirection("cz-en")}>CZ → EN</button>
            </div>
          </div>

          <label className="tf-check">
            <input type="checkbox" checked={onlyUnknown} onChange={(e) => setOnlyUnknown(e.target.checked)} />
            Jen karty, které ještě neumím
          </label>

          <div className="tf-decks">
            {Object.values(DECKS).map((deck) => {
              const known = deck.cards.filter((c) => progress[c.id] === 1).length;
              const all = deck.cards.length;
              const allKnown = known === all;
              return (
                <button key={deck.id} type="button" className="tf-deck" disabled={!loaded} onClick={() => startSession(deck.id)}>
                  <Bubble code={deck.code} count={all} />
                  <span className="tf-deck-text">
                    <span className="tf-deck-name">{deck.name}</span>
                    <span className="tf-deck-desc">{deck.desc}</span>
                    <span className="tf-meter"><span style={{ width: `${(known / all) * 100}%` }} /></span>
                    <span className="tf-deck-known">
                      {onlyUnknown && allKnown
                        ? "Umíš všechno, spustí se celý balíček"
                        : onlyUnknown
                          ? `Umím ${known} z ${all}, procvičíš ${all - known}`
                          : `Umím ${known} z ${all}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <button type="button" className={`tf-reset${resetArmed ? " is-armed" : ""}`} onClick={handleReset}>
            {resetArmed ? "Klikni znovu a pokrok se vymaže" : "Vymazat pokrok"}
          </button>
          <p className="tf-version">Verze {APP_VERSION}</p>
        </div>
      </div>
    );
  }

  const deck = DECKS[session.deckId];

  /* ---------------- Done screen ---------------- */
  if (screen === "done") {
    const missedIds = Object.keys(session.missed);
    return (
      <div className="tf-root">
        <style>{CSS}</style>
        <div className="tf-shell tf-done">
          <button type="button" className="tf-nav" onClick={() => setScreen("decks")}>
            <ArrowLeft size={18} /> Balíčky
          </button>
          <h2>Kolo dokončeno</h2>
          <p className="tf-done-lede">
            {deck.name}: {session.total} karet, napoprvé {session.total - missedIds.length}
            {missedIds.length > 0 ? `, s opakováním ${missedIds.length}.` : ". Všechno napoprvé."}
          </p>

          {missedIds.length > 0 && (
            <ul className="tf-missed" aria-label="Karty, které šly napoprvé špatně">
              {missedIds.map((id) => {
                const c = CARD_BY_ID[id];
                return (
                  <li key={id}>
                    <span className="en" lang="en">{c.en}</span>
                    <span className="cz" lang="cs">{c.cz}</span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="tf-done-actions">
            {missedIds.length > 0 && (
              <button type="button" className="tf-btn tf-btn-flip" onClick={() => startSession(deck.id, missedIds)}>
                Procvičit znovu {missedIds.length} chybných
              </button>
            )}
            <button type="button" className="tf-btn tf-btn-ghost" onClick={() => startSession(deck.id)}>
              Nové kolo celého balíčku
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- Study screen ---------------- */
  const card = CARD_BY_ID[session.queue[0]];
  const pct = (session.done / session.total) * 100;

  return (
    <div className="tf-root">
      <style>{CSS}</style>
      <div className="tf-shell">
        <div className="tf-studybar">
          <button type="button" className="tf-nav" onClick={() => { stopSpeech(); setScreen("decks"); }}>
            <ArrowLeft size={18} /> Balíčky
          </button>
          <span className="tf-count">Umím {session.done} z {session.total}</span>
        </div>
        <div className="tf-progress" role="progressbar" aria-valuemin={0} aria-valuemax={session.total} aria-valuenow={session.done}>
          <span style={{ width: `${pct}%` }} />
        </div>

        <CardView
          key={`${card.id}#${session.step}`}
          card={card}
          deck={deck}
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
    </div>
  );
}

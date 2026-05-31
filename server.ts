import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { BotInstance, BotConfig, BotState, LogEntry, Player, BotStats, DiscordCommandLog, UserPlan, UserProfile, OwnerConfig } from "./src/types.js";
import Stripe from "stripe";
import { readFileSync, writeFileSync, existsSync } from "fs";

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// AI Studio container uses port 3000 internally. We prioritize 3000 if running inside the AI Studio sandbox.
// On other external production hosting environments (like Render, Railway, or self-hosted servers), process.env.PORT is respected.
const PORT = process.env.APPLET_ID ? 3000 : (process.env.PORT ? Number(process.env.PORT) : 3000);

app.use(cors());
app.use(express.json());

// Initialize Gemini Client safely
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (apiKey && apiKey !== "MY_GEMINI_API_KEY") {
  try {
    ai = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    console.log("Gemini API client initialized successfully.");
  } catch (e) {
    console.error("Failed to initialize Gemini API client:", e);
  }
}

// In-memory Database / State Store & Persistence Setup
let activeUser: UserProfile = {
  email: "cvg450845@gmail.com",
  plan: "free",
  joinedAt: new Date().toISOString(),
};

const USER_FILE = path.join(process.cwd(), "user-profile.json");
try {
  if (existsSync(USER_FILE)) {
    const loadedData = JSON.parse(readFileSync(USER_FILE, "utf-8"));
    activeUser = { ...activeUser, ...loadedData };
  } else {
    writeFileSync(USER_FILE, JSON.stringify(activeUser, null, 2), "utf-8");
  }
} catch (e) {
  console.error("Failed to load or save user profile:", e);
}

function saveUserProfile() {
  try {
    writeFileSync(USER_FILE, JSON.stringify(activeUser, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save user profile:", e);
  }
}

// Owner's Merchant Accounts Config & Persistence
let ownerConfig: OwnerConfig = {
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
  basicPriceId: "",
  proPriceId: "",
  paymentLinkBasic: "",
  paymentLinkPro: "",
  payPalEmail: "cvg450845@gmail.com",
  cryptoAddress: "",
};

const OWNER_CONFIG_FILE = path.join(process.cwd(), "owner-config.json");
try {
  if (existsSync(OWNER_CONFIG_FILE)) {
    const loadedOwner = JSON.parse(readFileSync(OWNER_CONFIG_FILE, "utf-8"));
    ownerConfig = { ...ownerConfig, ...loadedOwner };
    // Prioritize environment variables if config was empty
    if (!ownerConfig.stripeSecretKey && process.env.STRIPE_SECRET_KEY) {
      ownerConfig.stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    }
    if (!ownerConfig.stripePublishableKey && process.env.STRIPE_PUBLISHABLE_KEY) {
      ownerConfig.stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
    }
  } else {
    writeFileSync(OWNER_CONFIG_FILE, JSON.stringify(ownerConfig, null, 2), "utf-8");
  }
} catch (e) {
  console.error("Failed to load or save owner config:", e);
}

function saveOwnerConfig() {
  try {
    writeFileSync(OWNER_CONFIG_FILE, JSON.stringify(ownerConfig, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save owner config:", e);
  }
}

let currentSecretKeyUsed = "";
let stripeInstance: any = null;

function getStripeClient() {
  const secret = ownerConfig.stripeSecretKey || process.env.STRIPE_SECRET_KEY || "";
  if (!secret || secret.trim() === "") return null;
  if (secret !== currentSecretKeyUsed || !stripeInstance) {
    currentSecretKeyUsed = secret;
    stripeInstance = new Stripe(secret);
  }
  return stripeInstance;
}

let botConfig: BotConfig = {
  ip: "play.hypixel.net",
  port: 25565,
  username: "MineSaaS_Bot",
  version: "1.20.4",
  autoReconnect: true,
  customWelcomeMessage: "Hello from MineSaaS Platform!",
  selectedAiPersonality: "Friendly Guard",
  edition: "java",
};

let botState: BotState = "offline";
let activeSecondsUsedToday = 0;
const FREE_PLAN_LIMIT_SECONDS = 4 * 60 * 60; // 4 Hours = 14400 seconds

const spawnCoords = { x: 124.5, y: 72.0, z: -432.2 };
let currentStats: BotStats = {
  health: 20,
  food: 20,
  level: 5,
  xp: 142,
  coords: { ...spawnCoords },
  inventory: [
    { name: "Diamond Pickaxe", count: 1, slot: 0 },
    { name: "Iron Sword", count: 1, slot: 1 },
    { name: "Cobblestone", count: 64, slot: 2 },
    { name: "Cooked Beef", count: 12, slot: 3 },
    { name: "Oak Wood Logs", count: 24, slot: 4 },
  ],
};

let simulatedPlayers: Player[] = [
  { username: "Steve", ping: 42 },
  { username: "Alex", ping: 35 },
  { username: "Notch", ping: 12 },
  { username: "xX_Miner_Xx", ping: 88 },
];

let botLogs: LogEntry[] = [];
let discordLogs: DiscordCommandLog[] = [];

// Base logging helper
function addLog(type: LogEntry["type"], message: string, sender?: string) {
  const newLog: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toLocaleTimeString(),
    type,
    message,
    sender,
  };
  botLogs.push(newLog);
  // Keep logs at max 150
  if (botLogs.length > 150) {
    botLogs.shift();
  }
}

// Pre-fill initial offline log
addLog("info", "Bot SaaS manager loaded. Bot status: OFFLINE.");

// Background Simulation Tick (Updates stats, coordinates, limit checker, random players)
let simulationInterval: NodeJS.Timeout | null = null;

function startSimulationTick() {
  if (simulationInterval) clearInterval(simulationInterval);

  simulationInterval = setInterval(() => {
    if (botState !== "online") return;

    // 1. Tracker for Free limit
    if (activeUser.plan === "free") {
      activeSecondsUsedToday += 1;
      if (activeSecondsUsedToday >= FREE_PLAN_LIMIT_SECONDS) {
        botState = "offline";
        addLog("error", "⏳ Free Plan Limit Reached: Your bot can only run for 4 hours daily under the Free plan. Upgrade to Basic or Pro AI to enjoy 24/7 unlimited uptime!");
        addLog("info", "Connection closed by scheduler.");
        return;
      }
    } else {
      // Paid plan can track active runtime for stats anyway
      activeSecondsUsedToday += 1;
    }

    // 2. Random Coordinates modification to simulate roaming
    if (Math.random() > 0.6) {
      currentStats.coords.x += parseFloat((Math.random() * 2 - 1).toFixed(1));
      currentStats.coords.z += parseFloat((Math.random() * 2 - 1).toFixed(1));
      
      // Keep within rational range
      if (Math.abs(currentStats.coords.x - spawnCoords.x) > 100) currentStats.coords.x = spawnCoords.x;
      if (Math.abs(currentStats.coords.z - spawnCoords.z) > 100) currentStats.coords.z = spawnCoords.z;
    }

    // 3. Random health / food fluctuation
    if (Math.random() > 0.95) {
      if (currentStats.food < 15) {
        currentStats.food = 20;
        addLog("info", "🍖 Bot eating Cooked Beef to regenerate health.");
      } else {
        currentStats.food -= 1;
      }
    }

    if (Math.random() > 0.96) {
      if (currentStats.health < 20) {
        currentStats.health = Math.min(20, currentStats.health + 1);
      } else if (Math.random() > 0.8) {
        currentStats.health -= 1;
        addLog("error", "💥 Bot took minor fall damage (coordinates registered minor height drop).");
      }
    }

    // 4. Random level / XP gain
    if (Math.random() > 0.98) {
      currentStats.xp += Math.floor(Math.random() * 15) + 5;
      if (currentStats.xp > 200) {
        currentStats.xp = 10;
        currentStats.level += 1;
        addLog("info", `✨ Bot leveled up! Current level: ${currentStats.level}`);
      }
    }

    // 5. Random other players chatter/actions in Minecraft server
    if (Math.random() > 0.94) {
      const chatPlayers = simulatedPlayers.filter(p => !p.isBot);
      if (chatPlayers.length > 0) {
        const randomPlayer = chatPlayers[Math.floor(Math.random() * chatPlayers.length)];
        const comments = [
          "Nice server!",
          `yo ${botConfig.username}, what are you crafting?`,
          "looking for diamonds at Y=11",
          "who wants to trade wood for iron?",
          "Be right back, mining",
          "This bot platform is super responsive",
          "lag?",
        ];
        const msg = comments[Math.floor(Math.random() * comments.length)];
        addLog("chat", msg, randomPlayer.username);

        // If the chat specifically addresses the bot, trigger custom automated response!
        if (msg.includes(botConfig.username) || Math.random() > 0.85) {
          triggerBotResponse(msg, randomPlayer.username);
        }
      }
    }

    // 6. Random player joining or leaving
    if (Math.random() > 0.97) {
      if (simulatedPlayers.length < 8) {
        const newNames = ["MinerMax", "PvP_Master66", "BlockCreeper", "SkyCopter", "LapisLover"];
        const unusedNames = newNames.filter(n => !simulatedPlayers.some(p => p.username === n));
        if (unusedNames.length > 0) {
          const joinedName = unusedNames[Math.floor(Math.random() * unusedNames.length)];
          simulatedPlayers.push({ username: joinedName, ping: Math.floor(Math.random() * 60) + 10 });
          addLog("info", `➕ ${joinedName} joined the Minecraft server.`);
        }
      } else if (simulatedPlayers.length > 3) {
        const playersToLeave = simulatedPlayers.filter(p => !p.isBot && p.username !== "Steve");
        const leaving = playersToLeave[Math.floor(Math.random() * playersToLeave.length)];
        simulatedPlayers = simulatedPlayers.filter(p => p.username !== leaving.username);
        addLog("info", `➖ ${leaving.username} left the Minecraft server.`);
      }
    }

  }, 1000);
}

// Bot response executor (Supports standard & AI automated triggers)
async function triggerBotResponse(userMessage: string, senderName: string) {
  if (botState !== "online") return;

  // Let the user know the bot is considering a reply
  setTimeout(async () => {
    // Check if user is on Pro AI plan and Gemini is active
    if (activeUser.plan === "pro-ai") {
      addLog("system", `🤖 [Pro AI] ${botConfig.username} is thinking of a response using Gemini...`);
      
      let repliedText = "";
      if (ai) {
        try {
          const personalityInstructions = {
            "Friendly Guard": "You are a friendly, brave, and helpful Minecraft castle guard. Keep sentences short (1-2 lines), talk informally but politely, reference defending coordinates, and welcome others.",
            "Witty Troll": "You are a witty, playful, and slightly goofy Minecraft jokester. Be short (1 line), send light-hearted jabs about mining efficiency or falling in lava, use lowercase, and be playful.",
            "Sassy AI Assistant": "You are an advanced sassy robot assistant in Minecraft. You find human mining speeds funny, answer with mechanical quirks, but always help accurately.",
            "Shy Explorer": "You are a shy, excited, and slightly nervous Minecraft explorer who loves flowers and wood logs. Speak hesitantly (e.g. 'uh, hi!'), be cute, short, and sweet."
          };
          const selectedPers = botConfig.selectedAiPersonality || "Friendly Guard";
          const systemRule = personalityInstructions[selectedPers as keyof typeof personalityInstructions] || personalityInstructions["Friendly Guard"];

          const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: `The player ${senderName} said in Minecraft chat: "${userMessage}". Give a short, single-line reaction (maximum 15 words) representing your personality. PERSONALITY: ${systemRule} (Do not use Markdown, do not use hashtags or emojis, keep it under 15 words, sound exact like a real Minecraft player chatting).`,
          });
          
          repliedText = response.text?.trim() || "";
        } catch (e) {
          console.error("Gemini failed, fallback to witty text:", e);
        }
      }

      if (!repliedText) {
        // Fallback simulated AI reply if key is default or request fails
        const templates = [
          `Hi @${senderName}, I'm operating on Pro AI mode, but the Gemini API is on standby. Standard automated greetings!`,
          `Beep boop! Hello @${senderName}, doing active exploration at coordinates X=${currentStats.coords.x.toFixed(0)}.`,
          `Greetings @${senderName}, guard duty in progress. 🛡️`
        ];
        repliedText = templates[Math.floor(Math.random() * templates.length)];
      }

      addLog("chat", repliedText, botConfig.username);
    } else {
      // Standard automated template replies for lower plans
      const standardReplies = [
        `Thanks for talking to me! Type "/mine" or "/help" to trigger coordinates checks.`,
        "Automated Node SaaS response: I'm currently running 24/7!",
        `Hey @${senderName}! I am currently mining cobblestone and wood.`,
        `Beep boop! I am currently spawning blocks. Current level: ${currentStats.level}.`,
      ];
      const reply = standardReplies[Math.floor(Math.random() * standardReplies.length)];
      addLog("chat", reply, botConfig.username);
    }
  }, 1200);
}

// REST API Routes

// User Profile Endpoints
app.get("/api/user/profile", (req, res) => {
  res.json({
    email: activeUser.email,
    plan: activeUser.plan,
    joinedAt: activeUser.joinedAt,
    remainingSeconds: FREE_PLAN_LIMIT_SECONDS - activeSecondsUsedToday,
    totalUsedToday: activeSecondsUsedToday,
  });
});

app.post("/api/user/login", (req, res) => {
  const { email, password } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }
  
  // Clean login state - preserve original plan if logging back, or reset
  activeUser.email = email;
  saveUserProfile();
  res.json({ success: true, profile: activeUser });
});

app.post("/api/user/plan", (req, res) => {
  const { plan } = req.body;
  if (plan !== "free" && plan !== "basic" && plan !== "pro-ai") {
    return res.status(400).json({ error: "Invalid plan" });
  }

  activeUser.plan = plan;
  saveUserProfile();
  addLog("system", `💳 Plan updated successfully to: [${plan.toUpperCase()}]`);
  res.json({ success: true, profile: activeUser });
});

app.post("/api/user/reset-timer", (req, res) => {
  activeSecondsUsedToday = 0;
  res.json({ success: true, remaining: FREE_PLAN_LIMIT_SECONDS });
});

// Bot Management Endpoints
app.get("/api/bot/state", (req, res) => {
  res.json({
    config: botConfig,
    status: botState,
    stats: currentStats,
    onlinePlayers: simulatedPlayers,
    logs: botLogs,
    activeSecondsUsedToday,
    freePlanLimitSeconds: FREE_PLAN_LIMIT_SECONDS,
  });
});

app.post("/api/bot/save-config", (req, res) => {
  const config: BotConfig = req.body;
  if (!config.ip || !config.username) {
    return res.status(400).json({ error: "Server IP and Username are required" });
  }

  const newEdition = config.edition || "java";
  let newPort = Number(config.port);
  if (!newPort) {
    newPort = newEdition === "bedrock" ? 19132 : 25565;
  }

  botConfig = {
    ...botConfig,
    ...config,
    edition: newEdition,
    port: newPort,
  };

  addLog("info", `⚙️ Bot configuration revised successfully. Protocol mode set to '${newEdition === "bedrock" ? "Bedrock Edition" : "Java Edition"}' on port ${newPort}.`);
  res.json({ success: true, config: botConfig });
});

app.post("/api/bot/start", (req, res) => {
  if (botState === "online" || botState === "connecting") {
    return res.status(400).json({ error: "Bot is already online or connecting." });
  }

  // Check limits first
  if (activeUser.plan === "free" && activeSecondsUsedToday >= FREE_PLAN_LIMIT_SECONDS) {
    return res.status(403).json({ 
      error: "Daily limit reached. Free users are limited to 4 hours per day. Upgrade to continue immediately!" 
    });
  }

  botState = "connecting";
  if (botConfig.edition === "bedrock") {
    addLog("info", `🔌 Initializing Bedrock UDP/RakNet connection to Minecraft server ${botConfig.ip}:${botConfig.port}...`);
    addLog("info", `🔑 Resolving Bedrock Xbox Live Authentication Token (XUID mapping) for: ${botConfig.username}`);
    addLog("info", `🔄 Negotiating RakNet datagram layer protocols (MCBE Version: ${botConfig.version}) ...`);
  } else {
    addLog("info", `🔌 Initializing connection to Minecraft server ${botConfig.ip}:${botConfig.port}...`);
    addLog("info", `🔑 Resolving session credentials for user: ${botConfig.username}`);
    addLog("info", `🔄 Negotiating protocols (Client Version: ${botConfig.version}) ...`);
  }

  // Simulate server connection delays nicely
  setTimeout(() => {
    botState = "online";
    if (botConfig.edition === "bedrock") {
      addLog("info", `✅ Successfully connected to Bedrock server ${botConfig.ip}:${botConfig.port}! (RakNet Ping: 24ms, Version: ${botConfig.version})`);
      addLog("info", `🌍 Entity registration: Spawning Bedrock client actor in world chunks...`);
    } else {
      addLog("info", `✅ Successfully connected to ${botConfig.ip}:${botConfig.port}!`);
      addLog("info", `🌍 Entity registration: Spawning player in world chunks...`);
    }
    addLog("info", `📍 Spawn vector: X=${spawnCoords.x}, Y=${spawnCoords.y}, Z=${spawnCoords.z}`);
    
    // Welcome chat message
    if (botConfig.customWelcomeMessage) {
      addLog("chat", botConfig.customWelcomeMessage, botConfig.username);
    } else {
      addLog("chat", "Hello there! Controlled via MineBot SaaS Platform.", botConfig.username);
    }

    // Spawn ticker
    startSimulationTick();
  }, 1800);

  res.json({ success: true, status: "connecting" });
});

app.post("/api/bot/stop", (req, res) => {
  if (botState === "offline") {
    return res.status(400).json({ error: "Bot is already disconnected." });
  }

  botState = "offline";
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  
  addLog("info", `🔌 Connection terminated cleanly by user request.`);
  addLog("info", `🛑 Mineflayer subprocess halted successfully.`);
  res.json({ success: true, status: "offline" });
});

// Sends chat message or custom instruction
app.post("/api/bot/send-chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message content cannot be blank." });
  }

  if (botState !== "online") {
    return res.status(400).json({ error: "Cannot send messages while bot is offline." });
  }

  // 1. Log user message on the console
  addLog("chat", message, "WebAdmin_User");

  // 2. Check if it's a command
  if (message.startsWith("/")) {
    const parts = message.substring(1).split(" ");
    const cmd = parts[0].toLowerCase();
    
    setTimeout(() => {
      if (cmd === "mine") {
        addLog("info", "⛏️ Mining action triggered. Locating cobblestone blocks...");
        currentStats.inventory.find(i => i.name === "Cobblestone")!.count += 4;
        addLog("info", "Inventory updated: Cobblestone accumulated (+4).");
      } else if (cmd === "jump") {
        addLog("info", "🦘 Action: Bot jumped in place.");
      } else if (cmd === "status") {
        addLog("info", `📊 Stats readout: Coords: [X:${currentStats.coords.x.toFixed(1)}, Y:${currentStats.coords.y.toFixed(1)}, Z:${currentStats.coords.z.toFixed(1)}] Food: ${currentStats.food}/20 Level: ${currentStats.level}`);
      } else {
        addLog("error", `Unknown panel command: "/${cmd}". Allowed: /mine, /jump, /status`);
      }
    }, 500);

    return res.json({ success: true });
  }

  // 3. Normal chat, triggers the auto reply logic
  triggerBotResponse(message, "WebAdmin_User");
  res.json({ success: true });
});

// Simulated Discord Bot Controller commands
app.post("/api/bot/discord-command", (req, res) => {
  const { command, username } = req.body;
  if (!command) {
    return res.status(400).json({ error: "Command content is required" });
  }

  const sender = username || "Discord_Admin#4832";
  let reply = "";

  if (command === "!start") {
    if (botState === "online" || botState === "connecting") {
      reply = `⚠️ Bot is already ${botState}! Currently monitoring: **${botConfig.ip}** as **${botConfig.username}**.`;
    } else if (activeUser.plan === "free" && activeSecondsUsedToday >= FREE_PLAN_LIMIT_SECONDS) {
      reply = `⏳ **Daily Free Limit reached (4h/day)** for this SaaS user. Update plan to run the bot 24/7!`;
    } else {
      botState = "connecting";
      addLog("discord", `💬 Discord command: !start executing by ${sender}`);
      addLog("info", `🔌 Discord-triggered boot: Connecting to ${botConfig.ip}:${botConfig.port}...`);
      
      setTimeout(() => {
        botState = "online";
        addLog("info", `✅ Successfully connected to ${botConfig.ip}! (Bot online via Discord command)`);
        startSimulationTick();
      }, 1500);

      reply = `🎮 **MineSaaS Bot is spinning up!**\n- Server: \`${botConfig.ip}:${botConfig.port}\`\n- Account: \`${botConfig.username}\`\nStatus will be updated shortly.`;
    }
  } else if (command === "!stop") {
    if (botState === "offline") {
      reply = `⚠️ Bot is already offline!`;
    } else {
      botState = "offline";
      if (simulationInterval) {
        clearInterval(simulationInterval);
        simulationInterval = null;
      }
      addLog("discord", `💬 Discord command: !stop executed by ${sender}`);
      addLog("info", `❌ Discord-triggered shutdown: Connection terminated.`);
      reply = `🛑 **Bot shutdown successfully.** Mineflayer subprocess halted cleanly.`;
    }
  } else if (command === "!status") {
    addLog("discord", `💬 Discord command: !status requested by ${sender}`);
    const remainingTime = activeUser.plan === "free" 
      ? `⏳ Limit Remaining: **${((FREE_PLAN_LIMIT_SECONDS - activeSecondsUsedToday) / 3600).toFixed(2)}h**` 
      : `💚 Plan: **${activeUser.plan.toUpperCase()}** (Unlimited 24/7 runtime!)`;

    reply = `📊 **Bot State Report**:\n- **Status:** \`${botState.toUpperCase()}\`\n- **Target Server:** \`${botConfig.ip}:${botConfig.port}\`\n- **Coordinates:** X: \`${currentStats.coords.x.toFixed(1)}\`, Y: \`${currentStats.coords.y.toFixed(1)}\`, Z: \`${currentStats.coords.z.toFixed(1)}\`\n- **Health:** \`${currentStats.health}/20\`, **Food:** \`${currentStats.food}/20\`\n- **Level:** \`${currentStats.level}\`\n- ${remainingTime}`;
  } else if (command === "!help") {
    reply = `🤖 **Available Discord Commands**:\n- \`!start\` : Connects the Minecraft Bot to the target server.\n- \`!stop\` : Disconnects the bot and turns off simulation.\n- \`!status\` : Fetches detailed coords and stats.\n- \`!help\` : Returns this overview list.`;
  } else {
    reply = `❌ Unknown command **"${command}"**. Try typing \`!help\` to see the master list.`;
  }

  const logEntry: DiscordCommandLog = {
    id: `${Date.now()}-${Math.random()}`,
    timestamp: new Date().toLocaleTimeString(),
    user: sender,
    command,
    reply,
  };

  discordLogs.unshift(logEntry);
  if (discordLogs.length > 50) discordLogs.pop();

  res.json({ success: true, reply, logEntry });
});

app.get("/api/bot/discord-logs", (req, res) => {
  res.json({ logs: discordLogs });
});

// --- Merchant / Owner Payment Billing Routes ---

app.get("/api/owner/config", (req, res) => {
  const maskedSecret = ownerConfig.stripeSecretKey
    ? "sk_live_••••" + ownerConfig.stripeSecretKey.slice(-4)
    : "";
  res.json({
    ...ownerConfig,
    stripeSecretKey: maskedSecret,
    hasRealSecretKey: !!(ownerConfig.stripeSecretKey || process.env.STRIPE_SECRET_KEY),
  });
});

app.post("/api/owner/config", (req, res) => {
  const config: OwnerConfig = req.body;
  
  let secretKey = config.stripeSecretKey;
  if (secretKey && secretKey.includes("••••")) {
    secretKey = ownerConfig.stripeSecretKey;
  }

  ownerConfig = {
    stripeSecretKey: secretKey || "",
    stripePublishableKey: config.stripePublishableKey || "",
    basicPriceId: config.basicPriceId || "",
    proPriceId: config.proPriceId || "",
    paymentLinkBasic: config.paymentLinkBasic || "",
    paymentLinkPro: config.paymentLinkPro || "",
    payPalEmail: config.payPalEmail || "cvg450845@gmail.com",
    cryptoAddress: config.cryptoAddress || "",
  };

  saveOwnerConfig();

  addLog("system", `⚙️ Merchant billing configuration revised successfully by Project Owner.`);
  res.json({ success: true, config: ownerConfig });
});

app.post("/api/payment/create-session", async (req, res) => {
  const { plan } = req.body;
  if (plan !== "basic" && plan !== "pro-ai") {
    return res.status(400).json({ error: "Invalid plan type." });
  }

  const customPaymentLink = plan === "basic" ? ownerConfig.paymentLinkBasic : ownerConfig.paymentLinkPro;
  if (customPaymentLink && customPaymentLink.trim() !== "") {
    return res.json({ success: true, simulated: false, url: customPaymentLink });
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return res.json({ 
      success: false, 
      simulated: true, 
      message: "No active merchant Stripe Secret Key is configured on the workspace server. Switching to secure simulator flow." 
    });
  }

  try {
    const origin = req.headers.origin || process.env.APP_URL || "http://localhost:3000";
    const successUrl = `${origin}/?session_id={CHECKOUT_SESSION_ID}&payment_status=success&plan=${plan}`;
    const cancelUrl = `${origin}/?payment_status=cancelled`;

    const planName = plan === "basic" ? "Minecraft Bot SaaS - Basic 24/7" : "Minecraft Bot SaaS - Pro AI Assistant";
    const planPrice = plan === "basic" ? 100 : 300; 
    const customPriceId = plan === "basic" ? ownerConfig.basicPriceId : ownerConfig.proPriceId;

    const lineItems = customPriceId 
      ? [{ price: customPriceId, quantity: 1 }]
      : [{
          price_data: {
            currency: "usd",
            product_data: {
              name: planName,
              description: plan === "basic"
                ? "Persistent 24/7 Minecraft server connection, unlimited threads, advanced macros."
                : "Continuous uptime with AI-powered conversational answers via Gemini LLM and 4 personalities.",
            },
            unit_amount: planPrice,
            recurring: { interval: "month" },
          },
          quantity: 1,
        }];

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: lineItems as any,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        plan,
        email: activeUser.email,
      },
    });

    res.json({ success: true, simulated: false, url: session.url });
  } catch (error: any) {
    console.error("Stripe Checkout Session error:", error);
    res.status(500).json({ error: error.message || "Failed to establish Stripe Checkout session." });
  }
});

app.get("/api/payment/confirm-session", async (req, res) => {
  const { session_id, plan } = req.query;
  if (!session_id || !plan) {
    return res.status(400).json({ error: "Missing session_id or plan parameter." });
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(400).json({ error: "Stripe configuration is missing on server." });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id as string);
    if (session.payment_status === "paid" || session.status === "complete") {
      const targetPlan = plan as UserPlan;
      activeUser.plan = targetPlan;
      saveUserProfile();
      
      addLog("system", `🛡️ Stripe verified payment captured successfully. Promoting client to [${targetPlan.toUpperCase()}] plan!`);
      res.json({ success: true, plan: targetPlan });
    } else {
      res.status(400).json({ error: `Payment session status is '${session.payment_status}'.` });
    }
  } catch (error: any) {
    console.error("Stripe retrieval error:", error);
    res.status(500).json({ error: error.message || "Stripe verification error." });
  }
});

// Vite Middleware & production static server integration
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server launched successfully on port ${PORT}`);
});

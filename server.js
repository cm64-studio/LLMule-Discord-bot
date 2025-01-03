require('dotenv').config();
const { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Collection } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const API_URL = process.env.LLM_API_ENDPOINT;
const API_KEY = process.env.API_KEY;
const MAX_MESSAGES = 2;
const MAX_RETRY_ATTEMPTS = 1;
const SETTINGS_FILE = 'user_settings.json';

// Initialize Discord REST
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Conversation history storage
const conversationHistory = new Map();

// Discord client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
});

// Rate limiting configuration
const USER_RATE_LIMIT = {
    messages: parseInt(process.env.USER_MESSAGES_PER_MINUTE) || 4,
    timeWindow: 60000, // 1 minute in milliseconds
    cooldown: parseInt(process.env.USER_COOLDOWN_MS) || 5000
};

// Rate limiting storage
const USER_MESSAGE_QUEUE = new Map();
const PROCESSING = new Set();

function isUserRateLimited(userId) {
    const now = Date.now();
    const queue = USER_MESSAGE_QUEUE.get(userId) || { messages: [], lastProcess: 0 };
    
    // Clean up old messages
    queue.messages = queue.messages.filter(time => now - time < USER_RATE_LIMIT.timeWindow);
    
    // Check rate limits
    if (queue.messages.length >= USER_RATE_LIMIT.messages) {
        const oldestMessage = queue.messages[0];
        const timeUntilNextAllowed = (USER_RATE_LIMIT.timeWindow - (now - oldestMessage));
        return {
            limited: true,
            timeUntilNext: Math.ceil(timeUntilNextAllowed / 1000)
        };
    }
    
    if (now - queue.lastProcess < USER_RATE_LIMIT.cooldown) {
        return {
            limited: true,
            timeUntilNext: Math.ceil((USER_RATE_LIMIT.cooldown - (now - queue.lastProcess)) / 1000)
        };
    }
    
    return { limited: false };
}

// Clean up user message queues periodically
setInterval(() => {
    const now = Date.now();
    for (const [userId, queue] of USER_MESSAGE_QUEUE.entries()) {
        queue.messages = queue.messages.filter(time => now - time < USER_RATE_LIMIT.timeWindow);
        if (queue.messages.length === 0) {
            USER_MESSAGE_QUEUE.delete(userId);
        }
    }
}, 60000);

// Commands collection
client.commands = new Collection();

// Define base commands without set-model (we'll add it dynamically)
const baseCommands = [
    new SlashCommandBuilder()
        .setName('models')
        .setDescription('List all available AI models'),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show available commands and how to use them'),
    new SlashCommandBuilder()
        .setName('clear-history')
        .setDescription('Clear your conversation history'),
    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Show current model and parameter settings'),
    new SlashCommandBuilder()
        .setName('set-parameter')
        .setDescription('Set a parameter value')
        .addStringOption(option =>
            option.setName('parameter')
                .setDescription('The parameter to set')
                .setRequired(true)
                .addChoices(
                    { name: 'temperature', value: 'temperature' },
                    { name: 'max_tokens', value: 'max_tokens' }
                ))
        .addNumberOption(option =>
            option.setName('value')
                .setDescription('The value to set')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('set-system-prompt')
        .setDescription('Set the system prompt for the AI')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('The system prompt to use')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('reset-settings')
        .setDescription('Reset all settings to default values'),
    new SlashCommandBuilder()
        .setName('set-memory')
        .setDescription('Set how many messages to remember')
        .addIntegerOption(option =>
            option.setName('messages')
                .setDescription('Number of messages to remember (1-10)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(10))
];

// Function to create commands with dynamic model choices
async function createCommands() {
    try {
        const models = await getAvailableModels();
        
        // Create the set-model command with choices
        const setModelCommand = new SlashCommandBuilder()
            .setName('set-model')
            .setDescription('Change the model to use')
            .addStringOption(option => {
                option.setName('model')
                    .setDescription('The model to use')
                    .setRequired(true);
                
                // Add each model as a choice
                models.forEach(model => {
                    const displayName = `${model.id}${model.tier ? ` (${model.tier})` : ''}`;
                    option.addChoices({ name: displayName, value: model.id });
                });
                
                return option;
            });

        // Combine base commands with the dynamic set-model command
        return [...baseCommands, setModelCommand];
    } catch (error) {
        console.error('Error creating commands with models:', error);
        // Fallback to base commands without set-model if models can't be fetched
        return baseCommands;
    }
}

// Register commands with Discord
async function registerCommands() {
    try {
        console.log('Started refreshing application (/) commands.');

        const allCommands = await createCommands();
        const commandsJson = allCommands.map(command => command.toJSON());
        
        // Register commands globally
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commandsJson }
        );

        // Also register commands for each guild the bot is in
        client.guilds.cache.forEach(async (guild) => {
            try {
                await rest.put(
                    Routes.applicationGuildCommands(client.user.id, guild.id),
                    { body: commandsJson }
                );
                console.log(`Registered commands for guild: ${guild.name}`);
            } catch (error) {
                console.error(`Error registering commands for guild ${guild.name}:`, error);
            }
        });

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

function updateConversationHistory(channelId, userMessage, botResponse, userId = null) {
    if (!conversationHistory.has(channelId)) {
        conversationHistory.set(channelId, []);
    }
    
    const history = conversationHistory.get(channelId);
    history.push(
        { role: "user", content: userMessage },
        { role: "assistant", content: botResponse }
    );
    
    const userSettings = userId ? getUserSettings(userId) : null;
    const maxMessages = userSettings?.memory || MAX_MESSAGES;
    
    while (history.length > maxMessages * 2) {
        history.shift();
    }
    
    conversationHistory.set(channelId, history);
}

// OpenAI-like API call configuration
const API_CONFIG = {
    temperature: 0.8,
    max_tokens: 644,
    top_p: 0.9,
    frequency_penalty: 0.1,
    presence_penalty: 0.1
};

// Function to parse parameters from message
function parseParameters(content) {
    const params = {
        model: process.env.LLM_MODEL,
        systemPrompt: process.env.SYSTEM_PROMPT,
        temperature: API_CONFIG.temperature,
        max_tokens: API_CONFIG.max_tokens
    };

    // Remove all parameter specifications and store them
    content = content.replace(/\[(model|system|temperature|max_tokens):([^\]]+)\]/g, (match, key, value) => {
        value = value.trim();
        switch(key) {
            case 'model':
                params.model = value;
                break;
            case 'system':
                params.systemPrompt = value;
                break;
            case 'temperature':
                params.temperature = parseFloat(value);
                break;
            case 'max_tokens':
                params.max_tokens = parseInt(value);
                break;
        }
        return '';
    }).trim();

    return { content, params };
}

// Add this before your getAPIResponse function
const debugRequest = (url, data, headers) => {
    console.log('Debug Request:', {
        url,
        data: {
            ...data,
            messages: data.messages.map(m => ({
                role: m.role,
                contentLength: m.content.length
            }))
        },
        headers: {
            ...headers,
            'x-api-key': headers['x-api-key'] ? '[REDACTED]' : undefined
        }
    });
};

// Load existing settings from file
function loadUserSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const loadedSettings = JSON.parse(data);
            userSettings.clear();
            Object.entries(loadedSettings).forEach(([userId, settings]) => {
                userSettings.set(userId, settings);
            });
            console.log('Loaded user settings from file');
        }
    } catch (error) {
        console.error('Error loading user settings:', error);
    }
}

// Save settings to file
function saveUserSettings() {
    try {
        const settingsObj = Object.fromEntries(userSettings);
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsObj, null, 2));
        console.log('Saved user settings to file');
    } catch (error) {
        console.error('Error saving user settings:', error);
    }
}

// Store user settings
const userSettings = new Map();

// Function to get default settings
function getDefaultSettings() {
    return {
        model: process.env.LLM_MODEL,
        temperature: API_CONFIG.temperature,
        max_tokens: API_CONFIG.max_tokens,
        memory: MAX_MESSAGES,
        systemPrompt: process.env.SYSTEM_PROMPT
    };
}

// Function to get user settings
function getUserSettings(userId) {
    if (!userSettings.has(userId)) {
        userSettings.set(userId, getDefaultSettings());
        saveUserSettings();
    }
    return userSettings.get(userId);
}

// Function to format parameter legend
function formatParameterLegend(settings) {
    return `\n\n*[LLMule params: model=${settings.model}, temp=${settings.temperature}, max_tokens=${settings.max_tokens}, memory=${settings.memory || MAX_MESSAGES}]*`;
}

// Function to format settings display
function formatSettings(settings) {
    return `**Current Settings**\n\n` +
           `🤖 Model: \`${settings.model}\`\n` +
           `🌡️ Temperature: \`${settings.temperature}\`\n` +
           `📝 Max Tokens: \`${settings.max_tokens}\`\n` +
           `💭 Memory: \`${settings.memory || MAX_MESSAGES}\` messages\n` +
           `💬 System Prompt: \`${settings.systemPrompt || process.env.SYSTEM_PROMPT}\`\n`;
}

// Function to format help message
function getHelpMessage() {
    return `**Available Commands**\n\n` +
           `🔍 \`/models\` - List all available AI models\n` +
           `🗑️ \`/clear-history\` - Clear your conversation history\n` +
           `⚙️ \`/settings\` - Show current model and parameters\n` +
           `🤖 \`/set-model <model>\` - Change the AI model\n` +
           `🎚️ \`/set-parameter <parameter> <value>\` - Set temperature or max_tokens\n` +
           `💭 \`/set-system-prompt <prompt>\` - Set the system prompt for the AI\n` +
           `💭 \`/set-memory <1-10>\` - Set how many messages to remember\n` +
           `🔄 \`/reset-settings\` - Reset all settings to default values\n` +
           `❓ \`/help\` - Show this help message\n\n` +
           `You can also chat with me by mentioning me (@bot)!`;
}

// Handle slash commands
client.on(Events.InteractionCreate, async interaction => {
    // Make sure it's a command interaction
    if (!interaction.isChatInputCommand()) return;

    try {
        const { commandName } = interaction;

        // Defer reply for commands that might take time
        if (['models', 'settings'].includes(commandName)) {
            await interaction.deferReply({ ephemeral: true });
        }

        switch (commandName) {
            case 'models':
                const models = await fetchAvailableModels();
                const modelsList = formatModelsTable(models);
                await interaction.editReply({ content: modelsList, ephemeral: true });
                break;

            case 'help':
                await interaction.reply({ content: getHelpMessage(), ephemeral: true });
                break;

            case 'clear-history':
                conversationHistory.delete(interaction.channelId);
                await interaction.reply({ content: '✨ Conversation history cleared!', ephemeral: true });
                break;

            case 'settings':
                const settings = getUserSettings(interaction.user.id);
                await interaction.editReply({ content: formatSettings(settings), ephemeral: true });
                break;

            case 'set-model':
                const newModel = interaction.options.getString('model');
                const userSettings = getUserSettings(interaction.user.id);
                userSettings.model = newModel;
                saveUserSettings();
                await interaction.reply({ content: `✅ Model set to: \`${newModel}\``, ephemeral: true });
                break;

            case 'set-parameter':
                const param = interaction.options.getString('parameter');
                const value = interaction.options.getNumber('value');
                const settings2 = getUserSettings(interaction.user.id);

                // Validate parameter values
                if (param === 'temperature' && (value < 0 || value > 2)) {
                    await interaction.reply({ content: '❌ Temperature must be between 0 and 2', ephemeral: true });
                    return;
                }
                if (param === 'max_tokens' && (value < 1 || value > 4000)) {
                    await interaction.reply({ content: '❌ Max tokens must be between 1 and 4000', ephemeral: true });
                    return;
                }

                settings2[param] = value;
                saveUserSettings();
                await interaction.reply({ content: `✅ ${param} set to: \`${value}\``, ephemeral: true });
                break;

            case 'set-system-prompt':
                const newPrompt = interaction.options.getString('prompt');
                const promptSettings = getUserSettings(interaction.user.id);
                promptSettings.systemPrompt = newPrompt;
                saveUserSettings();
                await interaction.reply({ 
                    content: `✅ System prompt set to: \`${newPrompt}\``, 
                    ephemeral: true 
                });
                break;

            case 'reset-settings':
                const defaultSettings = getDefaultSettings();
                userSettings.set(interaction.user.id, defaultSettings);
                saveUserSettings();
                await interaction.reply({ 
                    content: '✨ Settings reset to default values!\n' + formatSettings(defaultSettings), 
                    ephemeral: true 
                });
                break;

            case 'set-memory':
                const messageCount = interaction.options.getInteger('messages');
                const memorySettings = getUserSettings(interaction.user.id);
                memorySettings.memory = messageCount;
                saveUserSettings();
                await interaction.reply({ 
                    content: `✅ Message memory set to: \`${messageCount}\` messages`, 
                    ephemeral: true 
                });
                break;

            default:
                await interaction.reply({ content: 'Unknown command', ephemeral: true });
        }
    } catch (error) {
        console.error(`Error handling command ${interaction.commandName}:`, error);
        const reply = interaction.deferred 
            ? interaction.editReply({ content: 'Sorry, an error occurred while processing your command.', ephemeral: true })
            : interaction.reply({ content: 'Sorry, an error occurred while processing your command.', ephemeral: true });
        await reply;
    }
});

// Modify getAPIResponse to use user settings
async function getAPIResponse(channelId, prompt, retryCount = 0, customParams = null, userId = null) {
    try {
        const history = conversationHistory.get(channelId) || [];
        const userSettings = userId ? getUserSettings(userId) : null;
        
        const messages = [
            { role: "system", content: customParams?.systemPrompt || process.env.SYSTEM_PROMPT },
            ...history,
            { role: "user", content: prompt }
        ];

        const apiConfig = {
            ...API_CONFIG,
            temperature: customParams?.temperature ?? userSettings?.temperature ?? API_CONFIG.temperature,
            max_tokens: customParams?.max_tokens ?? userSettings?.max_tokens ?? API_CONFIG.max_tokens
        };

        const modelToUse = customParams?.model || userSettings?.model || process.env.LLM_MODEL;

        console.log(`Attempting API call for channel ${channelId}. Attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS + 1}`);

        debugRequest(API_URL, {
            model: modelToUse,
            messages: messages,
            ...apiConfig
        }, {
            'x-api-key': API_KEY,
            'Content-Type': 'application/json'
        });
        
        const response = await axios.post(API_URL, {
            model: modelToUse,
            messages: messages,
            ...apiConfig
        }, {
            headers: {
                'x-api-key': API_KEY,
                'Content-Type': 'application/json'
            }
        });

        // Detailed response logging
        console.log('Full API Response:', JSON.stringify(response.data, null, 2));
        console.log('API Response structure:', {
            status: response.status,
            hasData: !!response.data,
            dataKeys: Object.keys(response.data || {}),
            hasChoices: response.data?.choices?.length > 0
        });

        // Check if response has a different structure
        let botResponse;
        
        // Try to find the response content in different possible locations
        if (response.data?.choices?.[0]?.message?.content) {
            botResponse = response.data.choices[0].message.content;
        } else if (response.data?.response) {
            // Some APIs might return the response directly
            botResponse = response.data.response;
        } else if (response.data?.message) {
            // Or might have it under 'message'
            botResponse = response.data.message;
        } else if (typeof response.data === 'string') {
            // Or might return the string directly
            botResponse = response.data;
        } else {
            console.error('Unexpected API response structure:', response.data);
            throw new Error('Unexpected API response structure');
        }

        if (botResponse) {
            // Add parameter legend to response
            botResponse += formatParameterLegend(userSettings || getDefaultSettings());
            updateConversationHistory(channelId, prompt, botResponse, userId);
            return botResponse;
        } else {
            throw new Error('Could not extract response from API');
        }

    } catch (error) {
        // Enhanced error logging with request details
        console.error('Error communicating with API:', {
            error: error.message,
            status: error.response?.status,
            statusText: error.response?.statusText,
            responseData: error.response?.data,
            requestData: {
                url: API_URL,
                model: process.env.LLM_MODEL,
                channelId,
                retryCount,
                configUsed: API_CONFIG
            },
            headers: error.response?.headers,
            fullError: error.toString()
        });
        
        // Check for specific model not available error
        if (error.response?.data?.error?.code === 'model_not_available' || 
            (error.response?.data?.originalError?.code === 'NO_MODELS_AVAILABLE')) {
            return `Sorry, the language model "${process.env.LLM_MODEL}" is currently not available. This might be a temporary issue or the model might be under maintenance. Please try again later or contact support if the issue persists.`;
        }
        
        if (retryCount < MAX_RETRY_ATTEMPTS) {
            console.log(`Retry attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS}`);
            const backoffTime = 1000 * Math.pow(2, retryCount);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            return getAPIResponse(channelId, prompt, retryCount + 1);
        }
        
        return `Sorry, I encountered an error while processing your request. Error details: ${error.message}. Please try again later or contact support if the issue persists.`;
    }
}

// Function to fetch available models
async function fetchAvailableModels() {
    try {
        const response = await axios.get(`${API_URL.replace('/chat/completions', '/models')}`, {
            headers: {
                'x-api-key': API_KEY,
                'Content-Type': 'application/json'
            }
        });
        return response.data.data;
    } catch (error) {
        console.error('Error fetching models:', error);
        throw error;
    }
}

// Function to format models into a Discord table
function formatModelsTable(models) {
    // Sort models by tier
    const sortedModels = models.sort((a, b) => {
        const tierOrder = { small: 1, medium: 2, large: 3 };
        return (tierOrder[b.tier] || 0) - (tierOrder[a.tier] || 0);
    });

    // Create header
    let output = '**Available Models**\n\n';

    // Add each model with emoji and tier
    for (const model of sortedModels) {
        const modelName = model.id;
        const tier = model.tier ? `(${model.tier})` : '';
        output += `🤖 \`${modelName}\` ${tier}\n`;
    }

    return output;
}

// Cache for available models
let availableModelsCache = null;
let lastModelsFetch = 0;
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Function to get available models with caching
async function getAvailableModels() {
    const now = Date.now();
    if (!availableModelsCache || now - lastModelsFetch > MODEL_CACHE_TTL) {
        availableModelsCache = await fetchAvailableModels();
        lastModelsFetch = now;
    }
    return availableModelsCache;
}

// Load settings when bot starts
client.once(Events.ClientReady, async client => {
    console.log('Bot started as:', client.user.tag);
    loadUserSettings(); // Load existing settings
    await registerCommands();
});

// Update the message handler to use user rate limiting
client.on(Events.MessageCreate, async interaction => {
    if (!interaction.mentions.has(client.user.id) || 
        interaction.author.bot || 
        interaction.channel.id !== CHANNEL_ID) return;

    const channelId = interaction.channel.id;
    const userId = interaction.author.id;
    let content = interaction.content
        .replace(`<@${client.user.id}>`, '')
        .trim();

    if (!content) return;

    if (PROCESSING.has(userId)) {
        await interaction.reply("Please wait! I'm still processing your previous request 😅");
        return;
    }

    const rateLimitStatus = isUserRateLimited(userId);
    if (rateLimitStatus.limited) {
        await interaction.reply(`Please slow down! Try again in ${rateLimitStatus.timeUntilNext} seconds.`);
        return;
    }

    try {
        PROCESSING.add(userId);
        await interaction.channel.sendTyping();

        // Update user's message queue
        const queue = USER_MESSAGE_QUEUE.get(userId) || { messages: [], lastProcess: 0 };
        queue.messages.push(Date.now());
        queue.lastProcess = Date.now();
        USER_MESSAGE_QUEUE.set(userId, queue);

        // Parse parameters from the message
        const { content: cleanContent, params } = parseParameters(content);
        
        // Log the parameters being used
        console.log('Using parameters:', params);

        const response = await getAPIResponse(channelId, cleanContent, 0, params, userId);

        if (response.length > 2000) {
            const chunks = response.match(/.{1,2000}/g);
            for (const chunk of chunks) {
                await interaction.reply(chunk);
            }
        } else {
            await interaction.reply(response);
        }

    } catch (error) {
        console.error('Error processing message:', error);
        await interaction.reply('Sorry, an error occurred while processing your message.');
    } finally {
        PROCESSING.delete(userId);
    }
});

// Error handling
client.on(Events.Error, error => {
    console.error('Client error:', error);
});

// Command to clear conversation history
client.on(Events.MessageCreate, async interaction => {
    if (interaction.content === '!clear-history') {
        conversationHistory.delete(interaction.channel.id);
        await interaction.reply('Conversation history cleared! 🧹');
    }
});

// Add a function to refresh commands periodically
async function refreshCommands() {
    try {
        await registerCommands();
    } catch (error) {
        console.error('Error refreshing commands:', error);
    }
}

// Set up periodic refresh of commands to update model list
setInterval(refreshCommands, MODEL_CACHE_TTL);

client.login(process.env.DISCORD_TOKEN);
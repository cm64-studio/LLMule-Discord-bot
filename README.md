# LLMule Discord Bot

A Discord bot that integrates with LLMule API to provide AI chat capabilities with customizable parameters and model selection.

## Features

- 🤖 Multiple AI model support with dynamic model selection
- ⚙️ Customizable parameters (temperature, max tokens)
- 💭 Adjustable conversation memory
- 🔐 Per-user settings persistence
- 📝 Conversation history management
- 🚦 Configurable per-user rate limiting

## Commands

- `/models` - List all available AI models
- `/settings` - Show current model and parameter settings
- `/set-model <model>` - Change the AI model
- `/set-parameter <parameter> <value>` - Set temperature or max_tokens
- `/set-system-prompt <prompt>` - Set the system prompt for the AI
- `/set-memory <1-10>` - Set how many messages to remember
- `/reset-settings` - Reset all settings to default values
- `/clear-history` - Clear your conversation history
- `/help` - Show available commands

## Setup

1. Clone the repository:
```bash
git clone [your-repo-url]
cd LLMule-discord
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with the following variables:
```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_ID=your_channel_id
API_KEY=your_llmule_api_key
LLM_API_ENDPOINT=https://api.llmule.xyz/v1/chat/completions
LLM_MODEL=default_model_name
SYSTEM_PROMPT="You are a helpful assistant."
USER_MESSAGES_PER_MINUTE=3
USER_COOLDOWN_MS=5000
```

4. Start the bot:
```bash
node server.js
```

## Environment Variables

- `DISCORD_TOKEN`: Your Discord bot token
- `DISCORD_CHANNEL_ID`: Channel ID where the bot will operate
- `API_KEY`: LLMule API key
- `LLM_API_ENDPOINT`: LLMule API endpoint
- `LLM_MODEL`: Default model to use
- `SYSTEM_PROMPT`: Default system prompt for the AI
- `USER_MESSAGES_PER_MINUTE`: Maximum messages per user per minute (default: 3)
- `USER_COOLDOWN_MS`: Cooldown between messages in milliseconds (default: 5000)

## Usage

1. Mention the bot with your message:
```
@LLMule-bot How does photosynthesis work?
```

2. Use parameters in your message (optional):
```
@LLMule-bot [temperature:0.7] [max_tokens:1000] [system:Act as a biology teacher] Explain quantum computing
```

3. Use slash commands to manage settings:
```
/set-model gpt-4
/set-parameter temperature 0.8
/set-system-prompt "You are a helpful coding assistant"
/settings
```

## Rate Limiting

- Configurable messages per minute per user (default: 3)
- Configurable cooldown between messages (default: 5 seconds)
- Automatic queue management
- User-specific tracking

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details. 
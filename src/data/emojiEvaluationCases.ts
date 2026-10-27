// Public idea text only: no author, location, or photo metadata is needed.
export const productionRegressions = [
  { id: 24, summary: 'Another test, this time only providing details without summary.', details: 'Another test, this time only providing details without summary.', expected: ['📝'] },
  { id: 27, summary: 'Image upload test', details: 'Image upload test', expected: ['🖼️'] },
  {
    id: 30,
    summary: 'Review whether the browser interface or the API is responsible for the grammar correction on the Idea Mapper app.',
    details: "Hello, this is a test of the speech-to-text feature on my Idea Mapper web app. I am also going to test the auto-grammar fix, as you can see as I speak into the text box. Just now, the grammar seemed to have fixed itself. I don't know if that was the doing of the browser interface or if that was my, umm, if that was my API.",
    expected: ['💻', '📝'],
  },
  {
    id: 32,
    summary: 'Pedestrianize Akard St between Elm St and Commerce St in downtown Dallas to enhance safety and vibrancy.',
    details: 'Pedestrianizing Akard Street between Elm and Commerce in downtown Dallas would create a safer, more vibrant environment for residents, workers, and visitors.',
    expected: ['🚶'],
  },
  { id: 36, summary: 'Find a high-quality, low-cost grocery store.', details: 'Grocery store here, please. High quality, low price, please.', expected: ['🛒', '🧺', '🛍️'] },
  {
    id: 39,
    summary: 'Confirm that the interface functions smoothly and is easy to navigate.',
    details: "This is my idea. So, okay, once again, just testing if this works. It looks like it is; everything looks nice. It's pretty smooth. I think it's easy to figure out how to get around, so yeah.",
    expected: ['💻'],
  },
];


export const mockEmojiExamples = [
    '💨 ⚠️ ⚠️ 🚱 🐕 🐕 🐈 🐿️ 🐕 🐿️', // 1–10
    '🐺 🐕 🐕 🐕 🐈 🚧 🚲 🚲 🏠 🏗️',
    '🧪 🚗 🚗 💧 💧 🚻 🗑️ 🏊 📋 👍',
    '🗑️ 🏠 🚧 🏗️ 💧 🏗️ 💧 💧 💧 💧',
    '🚧 🌳 🏠 🧯 🚒 🔥 🎆 🔥 ⚠️ 🏗️',
    '💧 🎨 🎨 🎨 ♿ 🚓 ⚠️ 🏠 🗑️ 🌳',
    '💨 🚗 🚗 🚓 🚓 🚓 💧 🚧 🏗️ 🏠',
    '🌳 🌳 📚 📚 🔑 🚪 🦟 🦟 💨 🧹',
    '🧹 🚓 🚓 🚧 🔑 🎭 💰 🚓 🚓 🅿️',
    '🅿️ 🅿️ 🅿️ 🛣️ 🛣️ 🏗️ 🏗️ 🛤️ 🛤️ 🛤️',
    '🚆 🌳 🌳 🌳 🅿️ 🍽️ 🗑️ 🗑️ 🗑️ 🗑️',
    '🗑️ 🗑️ 🗑️ 🗑️ 🗑️ 🗑️ ♻️ ♻️ 🗑️ 🚸',
    '🚸 🚸 🚸 🚦 🛴 🚲 🚱 🚱 🚱 🛒',
    '🛒 🛒 🛒 🛒 🏠 ♿ 🚶 🚶 🏠 🧯',
    '🧯 🚭 ❄️ 🎭 🚗 🛣️ 🚧 💧 💧 🚱',
    '🚗 🚗 🚗 🏗️ 💧 🅿️ 🚧 🛣️ 🛣️ 🚸',
    '🛑 🚦 ⚠️ 🚦 🚦 🚦 🚦 🚸 🚦 🚦',
    '🚦 🚦 🚦 🚗 🍽️ 🍽️ 🚧 🅿️ 🌳 💧',
    '💳 💧 🗑️ 💧 💧 💧 💳 💳 💧 💧',
    '🛣️ 🌳 🚱 🐕 🗑️ 🚦', // 191–196
  ].flatMap(row => row.split(' '));

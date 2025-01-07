addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  if (url.pathname === '/webhook') {
    try {
      const update = await request.json()
      await handleUpdate(update)
      return new Response('OK')
    } catch (error) {
      console.error('Error parsing request or handling update:', error)
      return new Response('Bad Request', { status: 400 })
    }
  }
  return new Response('Not Found', { status: 404 })
}

async function handleUpdate(update) {
  if (update.message) {
    await onMessage(update.message)
  } else if (update.callback_query) {
    await onCallbackQuery(update.callback_query)
  }
}

async function onMessage(message) {
  const chatId = message.chat.id.toString()

  if (message.text && message.text === '/start') {
    await sendMessageToUser(chatId, "你好，欢迎使用私聊机器人！")
    return
  }

  if (chatId === GROUP_ID) {
    const topicId = message.message_thread_id
    if (topicId) {
      const privateChatId = await getPrivateChatId(topicId)
      if (privateChatId) {
        await forwardMessageToPrivateChat(privateChatId, message)
        return
      }
    }
  }

  try {
    const userInfo = await getUserInfo(chatId)
    const userName = userInfo.username || userInfo.first_name
    const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim()
    const topicName = `${nickname}`

    let topicId = await getExistingTopicId(chatId)
    if (!topicId) {
      topicId = await createForumTopic(topicName, userName, nickname, userInfo.id)
      await saveTopicId(chatId, topicId)
      await sendMessageToUser(chatId, "你好，欢迎使用私聊机器人！")
    }

    if (message.text) {
      const formattedMessage = `*${nickname}:*\n------------------------------------------------\n\n${message.text}`
      await sendMessageToTopic(topicId, formattedMessage)
    } else {
      await copyMessageToTopic(topicId, message)
    }
  } catch (error) {
    console.error(`Error handling message from chatId ${chatId}:`, error)
  }
}

async function getUserInfo(chatId) {
  const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId })
  })
  const data = await response.json()
  if (!data.ok) {
    throw new Error(`Failed to get user info: ${data.description}`)
  }
  return data.result
}

async function getExistingTopicId(chatId) {
  const topicId = await TOPIC_KV.get(chatId)
  return topicId
}

async function createForumTopic(topicName, userName, nickname, userId) {
  const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_ID, name: topicName })
  })
  const data = await response.json()
  if (!data.ok) {
    throw new Error(`Failed to create forum topic: ${data.description}`)
  }
  const topicId = data.result.message_thread_id

  const now = new Date()
  const formattedTime = now.toISOString().replace('T', ' ').substring(0, 19)

  const pinnedMessage = `昵称: ${nickname}\n用户名: ${userName}\nUserID: ${userId}\n发起时间: ${formattedTime}`
  const messageResponse = await sendMessageToTopic(topicId, pinnedMessage)
  const messageId = messageResponse.result.message_id
  await pinMessage(topicId, messageId)

  return topicId
}

async function saveTopicId(chatId, topicId) {
  await TOPIC_KV.put(chatId, topicId)
  await TOPIC_KV.put(topicId, chatId)
}

async function getPrivateChatId(topicId) {
  const privateChatId = await TOPIC_KV.get(topicId)
  return privateChatId
}

async function sendMessageToTopic(topicId, text) {
  console.log("Sending message to topic:", topicId, text);
  if (!text.trim()) {
    console.error(`Failed to send message to topic: message text is empty`);
    return;
  }

  try {
    const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: GROUP_ID,
        text: text,
        message_thread_id: topicId,
        parse_mode: 'Markdown'
      })
    });
    const data = await response.json();
    if (!data.ok) {
      console.error(`Failed to send message to topic: ${data.description}`);
    }
    return data;
  } catch (error) {
    console.error("Error sending message to topic:", error);
  }
}

async function copyMessageToTopic(topicId, message) {
  try {
    const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: GROUP_ID,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        message_thread_id: topicId
      })
    });
    const data = await response.json();
    if (!data.ok) {
      console.error(`Failed to copy message to topic: ${data.description}`);
    }
  } catch (error) {
    console.error("Error copying message to topic:", error);
  }
}

async function pinMessage(topicId, messageId) {
  try {
    const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: GROUP_ID,
        message_id: messageId,
        message_thread_id: topicId
      })
    });
    const data = await response.json();
    if (!data.ok) {
      console.error(`Failed to pin message: ${data.description}`);
    }
  } catch (error) {
    console.error("Error pinning message:", error);
  }
}

async function forwardMessageToPrivateChat(privateChatId, message) {
  console.log("Forwarding message to private chat:", privateChatId, message);
  try {
    const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: privateChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id
      })
    });
    const data = await response.json();
    if (!data.ok) {
      console.error(`Failed to forward message to private chat: ${data.description}`);
    }
  } catch (error) {
    console.error("Error forwarding message:", error);
  }
}

async function sendMessageToUser(chatId, text) {
  console.log("Sending message to user:", chatId, text);
  try {
    const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
    const data = await response.json();
    if (!data.ok) {
      console.error(`Failed to send message to user: ${data.description}`);
    }
  } catch (error) {
    console.error("Error sending message to user:", error);
  }
}

async function onCallbackQuery(callbackQuery) {
  // Handle callback query
}

async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
  for (let i = 0; i < retries; i++) {
    const response = await fetch(url, options)
    if (response.ok) {
      return response
    } else if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After')
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : backoff * Math.pow(2, i)
      await new Promise(resolve => setTimeout(resolve, delay))
    } else {
      console.error(`Request failed with status ${response.status}: ${response.statusText}`)
      throw new Error(`Request failed with status ${response.status}: ${response.statusText}`)
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} retries`)
}

export function sanitizeForOpenAI(messages: any[]): any[] {
  return messages.map((msg) => {
    if (Array.isArray(msg.content)) {
      const firstPart = msg.content[0];
      if (firstPart && firstPart.role && firstPart.content) {
        return { ...msg, content: firstPart.content };
      }

      return {
        ...msg,
        content: msg.content.map((part: any) => {
          if (part.text && !part.type) return { type: "text", text: part.text };
          return part;
        }),
      };
    }
    return msg;
  });
}
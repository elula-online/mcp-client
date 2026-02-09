import type { Message } from "../types";

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean;
  issue?: "leaked_json" | "describing_action" | "technical_jargon";
  correctionMessage?: Message;
}

/**
 * ResponseValidator checks LLM responses for common issues
 */
export class ResponseValidator {
  /**
   * Validate assistant response before accepting it
   */
  validate(content: string, loopCount: number, maxLoops: number): ValidationResult {
    if (!content || content.trim().length === 0) {
      return { isValid: true };
    }

    // Check for leaked JSON
    const leakedJsonResult = this.checkLeakedJson(content);
    if (!leakedJsonResult.isValid) {
      return leakedJsonResult;
    }

    // Check if describing action instead of doing it
    const describingResult = this.checkDescribingAction(content, loopCount, maxLoops);
    if (!describingResult.isValid) {
      return describingResult;
    }

    // Check for technical jargon
    const jargonResult = this.checkTechnicalJargon(content, loopCount, maxLoops);
    if (!jargonResult.isValid) {
      return jargonResult;
    }

    return { isValid: true };
  }

  /**
   * Check if LLM leaked JSON instead of using tool_calls
   */
  private checkLeakedJson(content: string): ValidationResult {
    if (!content.trim().startsWith("{")) {
      return { isValid: true };
    }

    if (
      content.includes('"name":') ||
      content.includes('"parameters":') ||
      content.includes('"function":')
    ) {
      console.warn("[Validator] Detected leaked JSON");

      return {
        isValid: false,
        issue: "leaked_json",
        correctionMessage: {
          role: "user",
          content: `SYSTEM ERROR: You outputted the tool call as raw text JSON. 

STOP. Do not write JSON in the response text. 
You must use the 'tool_calls' field protocol to execute tools.
Retry the tool call now correctly.`,
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Check if LLM is describing what it will do instead of doing it
   */
  private checkDescribingAction(
    content: string,
    loopCount: number,
    maxLoops: number,
  ): ValidationResult {
    // Don't check if we're near max loops
    if (loopCount >= maxLoops - 3) {
      return { isValid: true };
    }

    const patterns = [
      /the request (should|would|will) include/i,
      /request details are/i,
      /to (get|fetch|retrieve).*(the request|I need|should include)/i,
      /(channel|user|message):\s*[a-z]/i,
      /I will (call|use|execute|invoke)/i,
      /let me (call|use|execute|invoke)/i,
    ];

    const isDescribing = patterns.some((pattern) => pattern.test(content));

    if (isDescribing) {
      console.warn("[Validator] LLM is describing instead of acting");

      return {
        isValid: false,
        issue: "describing_action",
        correctionMessage: {
          role: "user",
          content: `CRITICAL ERROR: You are DESCRIBING what you would do instead of DOING it.

DO NOT explain what parameters you need or what the request should include.
IMMEDIATELY call the appropriate tool with the parameters you just described.

Call the tool NOW.`,
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Check for technical jargon that users shouldn't see
   */
  private checkTechnicalJargon(
    content: string,
    loopCount: number,
    maxLoops: number,
  ): ValidationResult {
    // Don't check if we're at max loops
    if (loopCount >= maxLoops - 1) {
      return { isValid: true };
    }

    const jargonPatterns = [
      /tool_[a-zA-Z0-9_]+_mattermost/i,
      /\bfunction\s+(call|name)/i,
      /\bparameter(s)?\s+(is|are|was|were)/i,
      /channel_id.*[a-z0-9]{26}/i,
      /I was unable to.*using the.*(function|tool)/i,
      /I have already provided.*in my previous response/i,
      /tool call/i,
      /API (endpoint|request|response)/i,
    ];

    const hasTechnicalJargon = jargonPatterns.some((pattern) =>
      pattern.test(content),
    );

    if (hasTechnicalJargon) {
      console.warn("[Validator] Technical jargon detected");

      return {
        isValid: false,
        issue: "technical_jargon",
        correctionMessage: {
          role: "user",
          content: `CRITICAL: Your response contains technical implementation details that users should not see. 

Rewrite your response following these rules:
1. NEVER mention tool names, function names, or technical processes
2. Present only the final result or information in a natural, friendly way
3. Use line breaks (\\n) and formatting for readability
4. If something failed, explain the issue simply without technical details

Rewrite your response now.`,
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Create initial loop guidance message
   */
  createInitialGuidance(): Message {
    return {
      role: "system",
      content: `CRITICAL INSTRUCTION: When you need information, you must IMMEDIATELY call the appropriate tool. DO NOT describe what you plan to do, what parameters you need, or what the request should include. Just call the tool directly.

Example - WRONG: "To get channel statistics, the request should include channel: paraat ai and message_limit: 100"
Example - CORRECT: [Immediately calls the tool with those parameters]

Call tools NOW when needed, don't describe your plan.`,
    };
  }

  /**
   * Create message when LLM provides no response
   */
  createNoResponseMessage(): Message {
    return {
      role: "user",
      content: `Provide your answer to the user now based on the information you've gathered. Do not mention any technical details. Please use line breaks (\\n) and other formatting.`,
    };
  }

  /**
   * Create final response prompt
   */
  createFinalResponsePrompt(): Message {
    return {
      role: "user",
      content: `You must now provide a final response to the user.

Requirements:
1. Use only the information you've gathered from successful tool calls
2. Organize information logically with proper formatting
3. DO NOT mention tools, functions, or technical processes
4. DO NOT apologize excessively
5. Use the data from tool results to give an informative response
6. Do not just read out raw tool arguments

Provide your final formatted response now.`,
    };
  }
}

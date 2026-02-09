import type { Message, ToolExecution } from "../types";
import type { ToolResult } from "../models/ToolResult";

/**
 * Agent loop states for state machine
 */
export enum AgentLoopState {
  INITIALIZING = "initializing",
  AWAITING_LLM_RESPONSE = "awaiting_llm",
  EXECUTING_TOOLS = "executing_tools",
  VALIDATING_RESPONSE = "validating_response",
  RECOVERING_FROM_ERROR = "recovering_from_error",
  COMPLETED = "completed",
  FAILED = "failed",
}

/**
 * State snapshot for debugging and observability
 */
export interface StateSnapshot {
  state: AgentLoopState;
  loopCount: number;
  productiveLoops: number;
  messageCount: number;
  successfulCalls: number;
  failedCalls: number;
  timestamp: Date;
}

/**
 * Centralized agent state management
 */
export class AgentState {
  state: AgentLoopState = AgentLoopState.INITIALIZING;
  loopCount: number = 0;
  productiveLoops: number = 0; // Only count loops that made actual progress
  messages: Message[] = [];
  toolExecutionHistory: Map<string, ToolExecution> = new Map();
  successfulToolCalls: Set<string> = new Set();
  discoveredIds: Map<string, string> = new Map();
  consecutiveFailures: number = 0;
  lastFailedToolName: string = "";
  totalErrors: number = 0;

  constructor(systemPrompt: string, userPrompt: string) {
    this.messages.push({ role: "system", content: systemPrompt });
    this.messages.push({ role: "user", content: userPrompt });
  }

  /**
   * Check if agent can continue processing
   */
  canContinue(): boolean {
    const maxLoops = 5;
    const maxErrors = 5;

    if (this.loopCount >= maxLoops) {
      console.warn(`[AgentState] Reached max loop count: ${maxLoops}`);
      return false;
    }

    if (this.totalErrors >= maxErrors) {
      console.warn(`[AgentState] Reached max error count: ${maxErrors}`);
      return false;
    }

    if (
      this.state === AgentLoopState.COMPLETED ||
      this.state === AgentLoopState.FAILED
    ) {
      return false;
    }

    return true;
  }

  /**
   * Mark that progress was made in this loop
   */
  markProgress(): void {
    this.productiveLoops++;
  }

  /**
   * Increment loop counter
   */
  incrementLoop(): void {
    this.loopCount++;
  }

  /**
   * Record tool execution result
   */
  recordToolExecution(
    toolSignature: string,
    result: any,
    success: boolean,
    errorType?: string,
  ): void {
    this.toolExecutionHistory.set(toolSignature, {
      signature: toolSignature,
      result,
      success,
      errorType: errorType as any,
      timestamp: new Date(),
    });

    if (success) {
      this.successfulToolCalls.add(toolSignature);
      this.consecutiveFailures = 0;
      this.lastFailedToolName = "";
    }
  }

  /**
   * Record tool failure
   */
  recordToolFailure(toolName: string): void {
    this.totalErrors++;

    if (this.lastFailedToolName === toolName) {
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 1;
      this.lastFailedToolName = toolName;
    }
  }

  /**
   * Check if tool call is duplicate
   */
  isDuplicateCall(toolSignature: string): boolean {
    return this.successfulToolCalls.has(toolSignature);
  }

  /**
   * Get previous result for duplicate call
   */
  getPreviousResult(toolSignature: string): any {
    return this.toolExecutionHistory.get(toolSignature)?.result;
  }

  /**
   * Add message to conversation
   */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * Add multiple tool results as messages
   */
  addToolResults(toolResults: ToolResult[]): void {
    for (const result of toolResults) {
      this.addMessage({
        role: "tool",
        tool_call_id: result.toolCallId,
        name: result.toolName,
        content: result.data || JSON.stringify(result.error),
      });
    }
  }

  /**
   * Get final answer from conversation
   */
  getFinalAnswer(): string {
    const finalAssistantMessage = this.messages
      .filter(
        (m) =>
          m.role === "assistant" && m.content && m.content.trim().length > 0,
      )
      .pop();

    return (
      finalAssistantMessage?.content ||
      "I apologize, but I was unable to complete your request. Please try rephrasing or provide more details."
    );
  }

  /**
   * Create a snapshot of current state for debugging
   */
  snapshot(): StateSnapshot {
    return {
      state: this.state,
      loopCount: this.loopCount,
      productiveLoops: this.productiveLoops,
      messageCount: this.messages.length,
      successfulCalls: this.successfulToolCalls.size,
      failedCalls: this.totalErrors,
      timestamp: new Date(),
    };
  }

  /**
   * Get metrics for response
   */
  getMetrics() {
    return {
      loops: this.loopCount,
      productiveLoops: this.productiveLoops,
      toolExecutions: this.toolExecutionHistory.size,
      successfulCalls: this.successfulToolCalls.size,
      failedCalls: this.totalErrors,
      finalState: this.state,
    };
  }

  /**
   * Check if we should force final response due to repeated failures
   */
  shouldForceFinalResponse(): boolean {
    return this.consecutiveFailures >= 2;
  }

  /**
   * Transition to new state
   */
  transitionTo(newState: AgentLoopState): void {
    console.log(`[AgentState] ${this.state} -> ${newState}`);
    this.state = newState;
  }
}

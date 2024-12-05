#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  CallToolResult,
  TextContent,
  ImageContent,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, Page } from 'playwright';
import fs from 'fs';
import puppeteer from 'puppeteer';

// Define the tools once to avoid repetition
const TOOLS: Tool[] = [
  {
    name: "playwright_navigate",
    description: "Navigate to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "playwright_screenshot",
    description: "Take a screenshot of the current page or a specific element",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the screenshot" },
        selector: { type: "string", description: "CSS selector for element to screenshot" },
        width: { type: "number", description: "Width in pixels (default: 800)" },
        height: { type: "number", description: "Height in pixels (default: 600)" },
      },
      required: ["name"],
    },
  },
  {
    name: "playwright_click",
    description: "Click an element on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for element to click" },
      },
      required: ["selector"],
    },
  },
  {
    name: "playwright_extract_dom",
    description: "Extract the DOM of the current page",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "playwright_fill",
    description: "Fill out an input field",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for input field" },
        value: { type: "string", description: "Value to fill" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "playwright_select",
    description: "Select an element on the page with Select tag",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for element to select" },
        value: { type: "string", description: "Value to select" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "playwright_hover",
    description: "Hover an element on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for element to hover" },
      },
      required: ["selector"],
    },
  },
  {
    name: "playwright_evaluate",
    description: "Execute JavaScript in the browser console",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript code to execute" },
      },
      required: ["script"],
    },
  },
];

// Global state
let browser: Browser | undefined;
let page: Page | undefined;
const consoleLogs: string[] = [];
const screenshots = new Map<string, string>();

async function ensureBrowser() {
  if (!browser) {
    const puppeteerChromiumPath = puppeteer.executablePath();

    browser = await chromium.launch({
      headless: false,
      executablePath: puppeteerChromiumPath,
    });

    const context = await browser.newContext();
    page = await context.newPage();

    page.on("console", (msg) => {
      const logEntry = `[${msg.type()}] ${msg.text()}`;
      consoleLogs.push(logEntry);
      server.notification({
        method: "notifications/resources/updated",
        params: { uri: "console://logs" },
      });
    });
  }
  return page!;
}

async function extractDom(page: Page): Promise<string> {
  return await page.evaluate(() => {
    function uniqueId(): () => string {
      let id = 0
      return () => {
        id++;
        return id.toString();
      }
    }

    function cleanupDom(element: any, window: any, idFunc: () => string, currentSlotElement = null): { compressedElement: any } {
      if (element instanceof window.Text) {
        const node = {
          type: "text",
          text: element.textContent?.replace(/\s+/g, ' ').trim(),
        };

        return {
          compressedElement: node,
        };
      }

      const elementId = idFunc();
      const attributes: Array<{ name: string, value: string }> = [];
      attributes.push({ name: "_id", value: elementId });

      if (
        element.tagName === "STYLE" ||
        element.tagName === "SCRIPT" ||
        element.tagName === "NOSCRIPT" ||
        element.tagName === "LINK" ||
        element.tagName === "META" ||
        element.tagName === "HEAD" ||
        element.tagName === "CODE" ||
        element.tagName === "SVG" ||
        element.getAttribute("type") === "hidden" ||
        element.getAttribute("disabled") === "true" ||
        element.getAttribute("aria-hidden") === "true"
      ) {
        return {
          compressedElement: null,
        };
      }

      if (element.assignedSlot && element.assignedSlot !== currentSlotElement) {
        return {
          compressedElement: null,
        };
      }

      if (element.tagName === "IFRAME") {
        throw new Error("IFRAME not supported");
      }

      let compressedChildren: { compressedElement: any }[] = [];
      let childNodes = [...element.childNodes, ...(element.shadowRoot?.childNodes ?? [])];

      if (element.tagName === "SLOT" && "assignedNodes" in element && typeof element.assignedNodes === "function") {
        childNodes.push(...element.assignedNodes());
      }

      childNodes.forEach(child => {
        if (child instanceof window.Text || child instanceof window.HTMLElement) {
          const compressedChild = cleanupDom(child, window, idFunc, element.tagName === "SLOT" ? element : currentSlotElement);
          if (compressedChild.compressedElement) {
            compressedChildren.push(compressedChild.compressedElement);
          }
        }
      });

      let value: string | number | null = null;

      if (
        element instanceof window.HTMLButtonElement ||
        element instanceof window.HTMLInputElement ||
        element instanceof window.HTMLTextAreaElement ||
        element instanceof window.HTMLLIElement ||
        element instanceof window.HTMLOptionElement
      ) {
        if (element instanceof window.HTMLInputElement) {
          attributes.push({ name: "value", value: element.value });
        } else if (typeof element.value === "string") {
          const trimmedValue = element.value.trim();
          if (trimmedValue) {
            if (element instanceof window.HTMLInputElement) {
              attributes.push({ name: "value", value: trimmedValue.replace(/\s+/g, ' ').trim() });
            } else {
              value = trimmedValue.replace(/\s+/g, ' ').trim();
            }
          }
        } else if (typeof element.value === "number") {
          value = element.value;
        }
      }

      element.getAttributeNames().forEach((attribute: string) => {
        const value = element.getAttribute(attribute);
        if (value !== null) {
          const trimmedValue = value.trim();
          if (!trimmedValue) return
          if (attribute === "role" && trimmedValue === "presentation") return
          if (element.tagName === "BUTTON" && trimmedValue === "button") return
          attributes.push({ name: attribute, value: trimmedValue.replace(/\s+/g, ' ').trim() })
        }
      });

      let compressedElement = {
        type: "element",
        tagName: element.tagName,
        attributes,
        children: compressedChildren,
        value: value
      };

      return {
        compressedElement,
      };
    }

    const idFunc = uniqueId();
    // Call the function
    const domTree = cleanupDom(window.document.body, window, idFunc);
    return JSON.stringify({
      domTree,
    });
  });
}

async function handleToolCall(name: string, args: any): Promise<CallToolResult> {
  const page = await ensureBrowser();

  switch (name) {
    case "playwright_navigate":
      await page.goto(args.url);
      return {
        content: [{
          type: "text",
          text: `Navigated to ${args.url}`,
        }],
        isError: false,
      };

    case "playwright_screenshot": {
      const width = args.width ?? 800;
      const height = args.height ?? 600;
      await page.setViewportSize({ width, height });

      const item = page.locator(args.selector);
      await item.waitFor();
      const screenshot = (await item.screenshot()).toString('base64');

      if (!screenshot) {
        return {
          content: [{
            type: "text",
            text: args.selector ? `Element not found: ${args.selector}` : "Screenshot failed",
          }],
          isError: true,
        };
      }

      screenshots.set(args.name, screenshot);
      server.notification({
        method: "notifications/resources/list_changed",
      });

      return {
        content: [
          {
            type: "text",
            text: `Screenshot '${args.name}' taken at ${width}x${height}`,
          } as TextContent,
          {
            type: "image",
            data: screenshot,
            mimeType: "image/png",
          } as ImageContent,
        ],
        isError: false,
      };
    }

    case "playwright_click":
      try {
        const item = page.locator(args.selector);
        await item.waitFor();
        await item.click();
        return {
          content: [{
            type: "text",
            text: `Clicked: ${args.selector}`,
          }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to click ${args.selector}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    case "playwright_fill":
      try {
        const item = page.locator(args.selector);
        await item.waitFor();
        await item.fill(args.value);
        return {
          content: [{
            type: "text",
            text: `Filled ${args.selector} with: ${args.value}`,
          }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to fill ${args.selector}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    case "playwright_select":
      try {
        const item = page.locator(args.selector);
        await item.waitFor();
        await item.selectOption(args.value);
        return {
          content: [{
            type: "text",
            text: `Selected ${args.selector} with: ${args.value}`,
          }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to select ${args.selector}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    case "playwright_extract_dom":
      try {
        const dom = await extractDom(page);
        fs.writeFileSync('/tmp/dom', dom);
        return {
          content: [{
            type: "text",
            text: dom,
          }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to extract DOM: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
      
    case "playwright_hover":
      try {
        const item = page.locator(args.selector);
        await item.waitFor();
        await item.hover();
        return {
          content: [{
            type: "text",
            text: `Hovered ${args.selector}`,
          }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to hover ${args.selector}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    case "playwright_evaluate":
      try {
        const result = await page.evaluate((script) => {
          const logs: string[] = [];
          const originalConsole = { ...console };

          ['log', 'info', 'warn', 'error'].forEach(method => {
            (console as any)[method] = (...args: any[]) => {
              logs.push(`[${method}] ${args.join(' ')}`);
              (originalConsole as any)[method](...args);
            };
          });

          try {
            const result = eval(script);
            Object.assign(console, originalConsole);
            return { result, logs };
          } catch (error) {
            Object.assign(console, originalConsole);
            throw error;
          }
        }, args.script);

        return {
          content: [
            {
              type: "text",
              text: `Execution result:\n${JSON.stringify(result.result, null, 2)}\n\nConsole output:\n${result.logs.join('\n')}`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Script execution failed: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    default:
      return {
        content: [{
          type: "text",
          text: `Unknown tool: ${name}`,
        }],
        isError: true,
      };
  }
}

const server = new Server(
  {
    name: "example-servers/puppeteer",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);


// Setup request handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "console://logs",
      mimeType: "text/plain",
      name: "Browser console logs",
    },
    ...Array.from(screenshots.keys()).map(name => ({
      uri: `screenshot://${name}`,
      mimeType: "image/png",
      name: `Screenshot: ${name}`,
    })),
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri.toString();

  if (uri === "console://logs") {
    return {
      contents: [{
        uri,
        mimeType: "text/plain",
        text: consoleLogs.join("\n"),
      }],
    };
  }

  if (uri.startsWith("screenshot://")) {
    const name = uri.split("://")[1];
    const screenshot = screenshots.get(name);
    if (screenshot) {
      return {
        contents: [{
          uri,
          mimeType: "image/png",
          blob: screenshot,
        }],
      };
    }
  }

  throw new Error(`Resource not found: ${uri}`);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  handleToolCall(request.params.name, request.params.arguments ?? {})
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

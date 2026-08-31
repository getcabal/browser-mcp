/**
 * The Vibe 0.3.6 compatibility contract, as data.
 *
 * CONTRACT_TOOLS is an implementation copy of the independently captured
 * tools/list fixture in test/fixtures/vibe-tools-0.3.6.json. EXTRA_TOOLS are
 * two local-only conveniences beyond that compatibility boundary.
 */

export const VERSION = '1.2.0';
export const PROTOCOL_VERSION = 2;

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface ContractTool extends ToolDefinition {
  description: string;
  title: string;
  annotations: ToolAnnotations;
}

type Schema = Record<string, unknown>;

const object = (properties: Record<string, Schema> = {}, required: string[] = []): Schema =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const string = (description: string): Schema => ({ type: 'string', description });
const number = (description: string): Schema => ({ type: 'number', description });
const boolean = (description: string): Schema => ({ type: 'boolean', description });

const tabId = number('Chrome tab ID; the active tab by default');
const uid = string('Element uid from the latest take_snapshot, e.g. @e12');
const waitTimeout = number('Maximum wait in milliseconds; defaults to 30000');
const readyTimeout = number('Readiness budget in milliseconds; defaults to 15000');

const annotate = (
  title: string,
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): ToolAnnotations => ({ title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint });

const tool = (
  name: string,
  description: string,
  inputSchema: Schema,
  annotations: ToolAnnotations,
): ContractTool => ({ name, description, inputSchema, title: annotations.title, annotations });

/** Exact Vibe 0.3.6 core contract, preserving tools/list order. */
export const CONTRACT_TOOLS: ContractTool[] = [
  {
    "name": "navigate_page",
    "title": "Navigate Page",
    "description": "Go to a URL, or back, forward, or reload on a specific page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "url",
            "back",
            "forward",
            "reload"
          ],
          "description": "Navigation mode"
        },
        "pageId": {
          "type": "number",
          "description": "Page ID to navigate"
        },
        "url": {
          "type": "string",
          "description": "Target URL (required when type='url')"
        },
        "timeoutMs": {
          "type": "number",
          "description": "Navigation timeout in milliseconds (used for type='url')",
          "default": 45000
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "type",
        "pageId"
      ]
    },
    "annotations": {
      "title": "Navigate Page",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "list_pages",
    "title": "List Pages",
    "description": "Get a list of pages open in the browser.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      }
    },
    "annotations": {
      "title": "List Pages",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "new_page",
    "title": "Open New Page",
    "description": "Open a new page and optionally navigate to a URL.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "focus": {
          "type": "boolean",
          "description": "If true, switch browser focus to the new page (default: false)",
          "default": false
        },
        "url": {
          "type": "string",
          "description": "Optional URL to navigate to in the new page"
        },
        "waitForReady": {
          "type": "boolean",
          "description": "Wait for page to be ready before returning (default: true)",
          "default": true
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      }
    },
    "annotations": {
      "title": "Open New Page",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "switch_to_page",
    "title": "Switch Page",
    "description": "Bring a specific browser page to the foreground by page ID.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "The ID of the page to switch to"
        },
        "waitForReady": {
          "type": "boolean",
          "description": "Wait for page visibility and hydration before returning (default: true)",
          "default": true
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "pageId"
      ]
    },
    "annotations": {
      "title": "Switch Page",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "close_page",
    "title": "Close Page",
    "description": "Close a browser page by ID. Refuses to close the last remaining page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "The ID of the page to close"
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "pageId"
      ]
    },
    "annotations": {
      "title": "Close Page",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "click",
    "title": "Click Element",
    "description": "Click an element on the page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "uid": {
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "openInNewTab": {
          "type": "boolean",
          "description": "If true and the element is a link, open in a new tab instead of navigating the current tab"
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "uid"
      ]
    },
    "annotations": {
      "title": "Click Element",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "fill",
    "title": "Fill Field",
    "description": "Fill a form field or select an option.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "uid": {
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "value": {
          "type": "string",
          "description": "The value to fill into the field"
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "uid",
        "value"
      ]
    },
    "annotations": {
      "title": "Fill Field",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "fill_form",
    "title": "Fill Form",
    "description": "Fill multiple form fields at once.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "elements": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "uid": {
                "description": "The uid of an element on the page from the page content snapshot"
              },
              "value": {
                "type": "string",
                "description": "Value to type into the field"
              }
            },
            "required": [
              "uid",
              "value"
            ]
          },
          "description": "Elements to fill"
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "elements"
      ]
    },
    "annotations": {
      "title": "Fill Form",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "upload_file",
    "title": "Upload File",
    "description": "Upload a file through a provided element.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "uid": {
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "filename": {
          "type": "string",
          "description": "Filename (top-level convenience form)."
        },
        "mimeType": {
          "type": "string",
          "description": "MIME type (top-level convenience form)."
        },
        "contentBase64": {
          "type": "string",
          "description": "Base64-encoded content (top-level convenience form)."
        },
        "content": {
          "type": "string",
          "description": "Legacy alias for top-level base64 content."
        },
        "file": {
          "type": "object",
          "properties": {
            "filename": {
              "type": "string",
              "description": "Name of the file to upload (for example report.pdf)"
            },
            "mimeType": {
              "type": "string",
              "description": "MIME type of the file (for example application/pdf)"
            },
            "contentBase64": {
              "type": "string",
              "description": "Base64-encoded file content"
            },
            "content": {
              "type": "string",
              "description": "Legacy alias for base64-encoded file content"
            }
          },
          "required": [
            "filename",
            "mimeType"
          ],
          "description": "File payload object to upload."
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "uid"
      ]
    },
    "annotations": {
      "title": "Upload File",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "type_text",
    "title": "Type Text",
    "description": "Type text using keyboard into a previously focused input.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "text": {
          "type": "string",
          "description": "The text to type"
        },
        "submitKey": {
          "type": "string",
          "description": "Optional key to press after typing (e.g., Enter, Tab, Escape)"
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "text"
      ]
    },
    "annotations": {
      "title": "Type Text",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "scroll_page",
    "title": "Scroll Page",
    "description": "Scroll the page up or down by a number of pages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "direction": {
          "type": "string",
          "enum": [
            "up",
            "down"
          ],
          "description": "Direction to scroll"
        },
        "numPages": {
          "type": "number",
          "description": "Number of pages to scroll"
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "direction",
        "numPages"
      ]
    },
    "annotations": {
      "title": "Scroll Page",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "wait_for",
    "title": "Wait For Element",
    "description": "Wait for any of the provided text snippets to appear on the selected page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "text": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Non-empty list of texts. Resolves when any value appears."
        },
        "timeout": {
          "type": "number",
          "description": "Maximum wait time in milliseconds",
          "default": 10000
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "text"
      ]
    },
    "annotations": {
      "title": "Wait For Element",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "wait_for_url",
    "title": "Wait For URL",
    "description": "Wait until the tab URL matches a glob pattern (e.g. 'https://example.com/dashboard*'). Use after clicking a link/button that triggers navigation to confirm the destination loaded. '*' matches any characters, '?' matches one. If the pattern contains no glob chars it is treated as a substring match.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID (optional - will use active tab if not specified)"
        },
        "pattern": {
          "type": "string",
          "description": "URL glob pattern or substring to wait for"
        },
        "timeout": {
          "type": "number",
          "description": "Maximum time to wait in milliseconds (0.5-60 seconds)",
          "default": 15000
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "pattern"
      ]
    },
    "annotations": {
      "title": "Wait For URL",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "wait_for_network_idle",
    "title": "Wait For Network Idle",
    "description": "Wait for the page to settle after a navigation or AJAX-heavy interaction: waits for the document to finish loading and for DOM mutations to go quiet for a short window. Use before reading page state when content loads asynchronously.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID (optional - will use active tab if not specified)"
        },
        "idleMs": {
          "type": "number",
          "description": "Required quiet window with no DOM activity, in milliseconds",
          "default": 800
        },
        "timeout": {
          "type": "number",
          "description": "Maximum time to wait in milliseconds (0.5-30 seconds)",
          "default": 10000
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      }
    },
    "annotations": {
      "title": "Wait For Network Idle",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "wait_for_condition",
    "title": "Wait For Condition",
    "description": "Wait until a JavaScript expression evaluated in the page becomes truthy. Provide a single expression (e.g. \"document.querySelectorAll('.row').length > 5\" or \"window.__APP_READY__ === true\"). Polls until truthy or timeout. Use for app-specific readiness signals that selectors/text waits cannot express.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID (optional - will use active tab if not specified)"
        },
        "expression": {
          "type": "string",
          "description": "JavaScript expression to evaluate in the page; resolves when it returns a truthy value"
        },
        "pollMs": {
          "type": "number",
          "description": "Polling interval in milliseconds",
          "default": 250
        },
        "timeout": {
          "type": "number",
          "description": "Maximum time to wait in milliseconds (0.5-60 seconds)",
          "default": 15000
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "expression"
      ]
    },
    "annotations": {
      "title": "Wait For Condition",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "evaluate_script",
    "title": "Evaluate Script",
    "description": "Evaluate a JavaScript function in the current page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "function": {
          "type": "string",
          "description": "A JavaScript function declaration to execute (for example: () => document.title or (el) => el?.innerText)."
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional function arguments. Accessibility refs from a11y snapshots (for example A0) are resolved to DOM elements when possible."
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "function"
      ]
    },
    "annotations": {
      "title": "Evaluate Script",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "press_key",
    "title": "Press Key",
    "description": "Press a key or key combination.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "keys": {
          "type": "string",
          "description": "Key or key combination (e.g., 'Enter', 'Escape', 'ArrowDown', 'Ctrl+C', 'Tab')"
        },
        "index": {
          "type": "number",
          "description": "Element index to send keys to (optional - uses focused element if not specified)"
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "keys"
      ]
    },
    "annotations": {
      "title": "Press Key",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "hover",
    "title": "Hover Element",
    "description": "Hover over an element by index.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "index": {
          "type": "number",
          "description": "Element index to hover over (from [index:score] format)"
        },
        "duration": {
          "type": "number",
          "description": "How long to maintain hover in milliseconds (100-5000ms)",
          "default": 1000
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "index"
      ]
    },
    "annotations": {
      "title": "Hover Element",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "drag",
    "title": "Drag Element",
    "description": "Drag from source to target.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "source": {
          "description": "Source element selector or coordinates {x, y}"
        },
        "target": {
          "description": "Target element selector or coordinates {x, y}"
        },
        "duration": {
          "type": "number",
          "description": "Duration of drag operation in milliseconds",
          "default": 500
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "source",
        "target"
      ]
    },
    "annotations": {
      "title": "Drag Element",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "resize_page",
    "title": "Resize Page",
    "description": "Resize the browser viewport for a page. Useful for responsive testing and ensuring content fits within specific dimensions.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "The tab ID to resize"
        },
        "width": {
          "type": "number",
          "description": "Viewport width in pixels"
        },
        "height": {
          "type": "number",
          "description": "Viewport height in pixels"
        },
        "deviceScaleFactor": {
          "type": "number",
          "description": "Device scale factor (default 1)",
          "default": null
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId",
        "width",
        "height"
      ]
    },
    "annotations": {
      "title": "Resize Page",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "take_screenshot",
    "title": "Take Screenshot",
    "description": "Take a screenshot of the current page. Use when visual context is needed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "number",
          "description": "Tab ID"
        },
        "maxWidth": {
          "type": "number",
          "description": "Maximum width in pixels (will maintain aspect ratio)",
          "default": 1024
        },
        "grayscale": {
          "type": "boolean",
          "description": "Convert to grayscale to reduce token usage when color isn't critical",
          "default": false
        },
        "quality": {
          "type": "number",
          "description": "JPEG quality (10-90, higher = better quality but more tokens",
          "default": 70
        },
        "detail": {
          "type": "string",
          "enum": [
            "low",
            "high"
          ],
          "description": "Detail level - 'low' for basic layout, 'high' for detailed analysis",
          "default": "low"
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      },
      "required": [
        "tabId"
      ]
    },
    "annotations": {
      "title": "Take Screenshot",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "take_snapshot",
    "title": "Take Page Snapshot",
    "description": "Take a page snapshot. Returns markdown by default. Use format='accessibility_tree' for semantic roles/names tree, or format='aria' for ARIA tree with locator hints. Usually NOT needed — page state is auto-provided after every tool call. Token-efficiency options: compact (drop empty decorative nodes), maxDepth (cap tree depth), scopeSelector (limit to a CSS subtree). Set changedOnly=true to get just a page-change signal instead of a full re-emit when nothing changed since your last snapshot.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "format": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree",
            "aria"
          ],
          "description": "Output format: markdown (default), accessibility_tree, or aria",
          "default": "markdown"
        },
        "compact": {
          "type": "boolean",
          "description": "Drop empty decorative/structural nodes (smaller snapshot). Applies to accessibility_tree/aria formats."
        },
        "maxDepth": {
          "type": "number",
          "description": "Cap the rendered tree depth relative to the root (smaller snapshot). Applies to accessibility_tree/aria formats."
        },
        "scopeSelector": {
          "type": "string",
          "description": "Limit the snapshot to the first element matching this CSS selector (main frame). Applies to accessibility_tree/aria formats."
        },
        "changedOnly": {
          "type": "boolean",
          "description": "If true and the page is unchanged since the last take_snapshot (same format), return a short 'page unchanged' signal instead of the full snapshot."
        },
        "pageId": {
          "type": "number",
          "description": "Page ID (optional - uses active page)"
        },
        "tabId": {
          "type": "number",
          "description": "Deprecated alias for pageId."
        },
        "pageStateFormat": {
          "type": "string",
          "enum": [
            "markdown",
            "accessibility_tree"
          ],
          "description": "Optional page-state format to append after tool execution. When omitted, no page state is appended. Set to \"markdown\" (indexed content) or \"accessibility_tree\" (for forms, editors, contenteditable fields, or role/name-oriented custom controls)."
        }
      }
    },
    "annotations": {
      "title": "Take Page Snapshot",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  }
];

/** Local-only conveniences kept beyond the Vibe compatibility contract. */
export const EXTRA_TOOLS: ContractTool[] = [
  tool('get_text', 'Read visible page text.',
    object({ tabId: number('Chrome tab ID') }),
    annotate('Get Page Text', true, false, true, false)),
  tool('evaluate', 'Evaluate JavaScript in the page and return its value.',
    object({ expression: string('JavaScript expression'), tabId: number('Chrome tab ID') }, ['expression']),
    annotate('Evaluate JavaScript', false, true, false, true)),
];

export const ALL_TOOLS: ContractTool[] = [...CONTRACT_TOOLS, ...EXTRA_TOOLS];
export const CONTRACT_TOOL_NAMES: string[] = CONTRACT_TOOLS.map((t) => t.name);

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compare what an extension advertises against the Vibe 0.3.6 contract.
 * Returns human-readable problems; an empty array means the full contract
 * (and nothing unknown) is being served.
 */
export function validateExtensionTools(advertised: ToolDefinition[]): string[] {
  const problems: string[] = [];
  const byName = new Map(advertised.map((t) => [t.name, t]));
  for (const expected of CONTRACT_TOOLS) {
    const actual = byName.get(expected.name);
    if (!actual) {
      problems.push(`missing tool: ${expected.name}`);
      continue;
    }
    if (actual.description !== expected.description) {
      problems.push(`tool ${expected.name}: description differs from the Vibe 0.3.6 contract`);
    }
    if (stableStringify(actual.inputSchema) !== stableStringify(expected.inputSchema)) {
      problems.push(`tool ${expected.name}: inputSchema differs from the Vibe 0.3.6 contract`);
    }
  }
  for (const actual of advertised) {
    if (!BY_NAME.has(actual.name)) problems.push(`unexpected tool: ${actual.name}`);
  }
  return problems;
}

/** Merge title + annotations onto extension-provided definitions for tools/list. */
export function enrichTools(tools: ToolDefinition[]): Array<ToolDefinition & Partial<Pick<ContractTool, 'title' | 'annotations'>>> {
  return tools.map((toolDef) => {
    const known = BY_NAME.get(toolDef.name);
    if (!known) return toolDef;
    return {
      ...toolDef,
      title: known.title,
      annotations: known.annotations,
    };
  });
}

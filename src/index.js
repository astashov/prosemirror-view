const {scrollPosIntoView, posAtCoords, coordsAtPos, DOMAfterPos} = require("./dompos")
const {draw, redraw} = require("./draw")
const {initInput, finishUpdateFromDOM, dispatchKeyDown, dispatchKeyPress} = require("./input")
const {SelectionReader, selectionToDOM} = require("./selection")
const {viewDecorations, addDummy} = require("./decoration")

;({Decoration: exports.Decoration, DecorationSet: exports.DecorationSet} = require("./decoration"))

// ::- An editor view manages the DOM structure that represents an
// editor. Its state and behavior are determined by its
// [props](#view.EditorProps).
class EditorView {
  // :: (?union<dom.Node, (dom.Node)>, EditorProps)
  // Create a view. `place` may be a DOM node that the editor should
  // be appended to, or a function that will place it into the
  // document. If it is `null`, the editor will not be added to the
  // document.
  constructor(place, props) {
    // :: EditorProps
    // The view's current [props](#view.EditorProps).
    this.props = props
    // :: EditorState
    // The view's current [state](#state.EditorState).
    this.state = this.drawnState = props.state
    this.dirty = null

    // :: dom.Node
    // The editable DOM node containing the document. (You probably
    // should not be directly interfering with its child nodes.)
    this.content = document.createElement("div")
    this.content.setAttribute("pm-container", "true")
    this.content.classList.add("ProseMirror-content")

    this.wrapper = document.createElement("div")
    this.wrapper.appendChild(this.content)

    this._root = null

    this.updateDOMForProps()

    if (place && place.appendChild) place.appendChild(this.wrapper)
    else if (place) place(this.wrapper)

    draw(this, this.state.doc, this.drawnDecorations = viewDecorations(this))
    this.content.contentEditable = true

    this.lastSelectedNode = null
    this.selectionReader = new SelectionReader(this)
    initInput(this)
  }

  // :: (EditorProps)
  // Update the view's props. Will immediately cause an update to
  // the view's DOM.
  update(props) {
    this.props = props
    this.updateState(props.state)
    this.updateDOMForProps()
  }

  // :: (EditorState)
  // Update the editor's `state` prop, without touching any of the
  // other props.
  updateState(state) {
    this.state = state

    if (this.inDOMChange) {
      if (state.view.inDOMChange != this.inDOMChange.id)
        setTimeout(() => finishUpdateFromDOM(this), 0)
      return
    } else if (state.view.inDOMChange != null) {
      setTimeout(() => this.props.onAction({type: "endDOMChange"}), 0)
      return
    }

    let redrawn = false
    let docChange = !state.doc.eq(this.drawnState.doc)

    let decorations = viewDecorations(this)
    if (docChange || this.dirty || !decorations.sameOutput(this.drawnDecorations)) {
      this.redraw(state.doc, decorations)
      redrawn = true
    }

    if (redrawn || !state.selection.eq(this.drawnState.selection))
      selectionToDOM(this, state.selection)

    // FIXME somehow schedule this relative to ui/update so that it
    // doesn't cause extra layout
    if (state.view.scrollToSelection)
      scrollPosIntoView(this, state.selection.head == null ? state.selection.from : state.selection.from)

    // Make sure we don't use an outdated range on drop event
    if (this.dragging && docChange) this.dragging.move = false
    this.drawnState = state
  }

  redraw(doc, decorations) {
    let oldDecorations = this.drawnDecorations, oldDoc = this.drawnState.doc
    this.drawnDecorations = decorations

    if (this.dirty) {
      let $start = oldDoc.resolve(this.dirty.from), $end = oldDoc.resolve(this.dirty.to), same = $start.sameDepth($end)
      this.dirty = null
      if (same == 0)
        return draw(this, doc, decorations)
      oldDecorations = addDummy(decorations, doc, $start.before(same), $start.after(same))
    }
    redraw(this, oldDoc, doc, oldDecorations, decorations)
  }

  updateDOMForProps() {
    let spellcheck = !!this.someProp("spellcheck")
    if (spellcheck != this.content.spellcheck) this.content.spellcheck = spellcheck
    let label = this.someProp("label", f => f(this.state)) || ""
    if (this.content.getAttribute("aria-label") != label) this.content.setAttribute("aria-label", label)
    let className = "ProseMirror"
    this.someProp("class", f => { let cls = f(this.state); if (cls) className += " " + cls })
    if (this.wrapper.className != className) this.wrapper.className = className
  }

  // :: () → bool
  // Query whether the view has focus.
  hasFocus() {
    if (this.content.ownerDocument.activeElement != this.content) return false
    let sel = this.root.getSelection()
    return sel.rangeCount && this.content.contains(sel.anchorNode.nodeType == 3 ? sel.anchorNode.parentNode : sel.anchorNode)
  }

  // :: (string, (prop: *) → *) → *
  // Goes over the values of a prop, first those provided directly,
  // then those from plugins (in order), and calls `f` every time a
  // non-undefined value is found. When `f` returns a truthy value,
  // that is immediately returned. When `f` isn't provided, it is
  // treated as the identity function (the prop value is returned
  // directly).
  someProp(propName, f) {
    let prop = this.props && this.props[propName], value
    if (prop && (value = f ? f(prop) : prop)) return value
    let plugins = this.state.plugins
    if (plugins) for (let i = 0; i < plugins.length; i++) {
      let prop = plugins[i].props[propName]
      if (prop != null && (value = f ? f(prop) : prop)) return value
    }
  }

  // :: ()
  // Focus the editor.
  focus() {
    selectionToDOM(this, this.state.selection, true)
    this.content.focus()
  }

  // :: union<dom.Document, dom.DocumentFragment>
  // Get the document root in which the editor exists. This will
  // usually be the top-level `document`, but might be a shadow DOM
  // root if the editor is inside a shadow DOM.
  get root() {
    let cached = this._root
    if (cached == null) for (let search = this.wrapper.parentNode; search; search = search.parentNode) {
      if (search.nodeType == 9 || (search.nodeType == 11 && search.host))
        return this._root = search
    }
    return cached || document
  }

  // :: ({left: number, top: number}) → ?{pos: number, inside: number}
  // Given a pair of coordinates, return the document position that
  // corresponds to them. May return null if the given coordinates
  // aren't inside of the visible editor. When an object is returned,
  // its `pos` property is the position nearest to the coordinates,
  // and its `inside` property holds the position before the inner
  // node that the click happened inside of, or -1 if the click was at
  // the top level.
  posAtCoords(coords) { return posAtCoords(this, coords) }

  // :: (number) → {left: number, right: number, top: number, bottom: number}
  // Returns the screen rectangle at a given document position. `left`
  // and `right` will be the same number, as this returns a flat
  // cursor-ish rectangle.
  coordsAtPos(pos) { return coordsAtPos(this, pos) }

  // :: (number) → ?NodeView
  // Find the node view for the node at the given position, if any.
  nodeViewAtPos(pos) {
    return DOMAfterPos(this, pos).pmNodeView
  }

  dispatchKeyDown(event) {
    return dispatchKeyDown(this, event)
  }

  dispatchKeyPress(event) {
    return dispatchKeyPress(this, event)
  }
}
exports.EditorView = EditorView

// EditorProps:: interface
//
// The configuration object that can be passed to an editor view. It
// supports the following properties (only `state` and `onAction` are
// required).
//
// The various event-handling functions may all return `true` to
// indicate that they handled the given event. The view will then take
// care to call `preventDefault` on the event, except with
// `handleDOMEvent, where the handler itself is responsible for that.
//
// Except for `state` and `onAction`, these may also be present on the
// `props` property of plugins. How a prop is resolved depends on the
// prop. Handler functions are called one at a time, starting with the
// plugins (in order of appearance), and finally looking at the base
// props, until one of them returns true. For some props, the first
// plugin that yields a value gets precedence. For `class`, all the
// classes returned are combined.
//
//   state:: EditorState
//   The state of the editor.
//
//   onAction:: (action: Action)
//   The callback over which to send actions (state updates) produced
//   by the view. You'll usually want to make sure this ends up
//   calling the view's [`update`](#view.EditorView.update) method
//   with a new state that has the action
//   [applied](#state.EditorState.applyAction).
//
//   handleDOMEvent:: ?(view: EditorView, event: dom.Event) → bool
//   Called before the view handles a DOM event. This is a kind of
//   catch-all override hook. Contrary to the other event handling
//   props, when returning true from this one, you are responsible for
//   calling `preventDefault` yourself (or not, if you want to allow
//   the default behavior).
//
//   handleKeyDown:: ?(view: EditorView, event: dom.KeyboardEvent) → bool
//   Called when the editor receives a `keydown` event.
//
//   handleKeyPress:: ?(view: EditorView, event: dom.KeyboardEvent) → bool
//   Handler for `keypress` events.
//
//   handleTextInput:: ?(view: EditorView, from: number, to: number, text: string) → bool
//   Whenever the user directly input text, this handler is called
//   before the input is applied. If it returns `true`, the default
//   effect of actually inserting the text is suppressed.
//
//   handleClickOn:: ?(view: EditorView, pos: number, node: Node, nodePos: number, event: dom.MouseEvent) → bool
//   Called for each node around a click, from the inside out.
//
//   handleClick:: ?(view: EditorView, pos: number, event: dom.MouseEvent) → bool
//   Called when the editor is clicked, after `handleClickOn` handlers
//   have been called.
//
//   handleDoubleClickOn:: ?(view: EditorView, pos: number, node: Node, nodePos: number, event: dom.MouseEvent) → bool
//   Called for each node around a double click.
//
//   handleDoubleClick:: ?(view: EditorView, pos: number, event: dom.MouseEvent) → bool
//   Called when the editor is double-clicked, after `handleDoubleClickOn`.
//
//   handleTripleClickOn:: ?(view: EditorView, pos: number, node: Node, nodePos: number, event: dom.MouseEvent) → bool
//   Called for each node around a triple click.
//
//   handleTripleClick:: ?(view: EditorView, pos: number, event: dom.MouseEvent) → bool
//   Called when the editor is triple-clicked, after `handleTripleClickOn`.
//
//   handleContextMenu:: ?(view: EditorView, pos: number, event: dom.MouseEvent) → bool
//   Called when a context menu event is fired in the editor.
//
//   onFocus:: ?(view: EditorView, event: dom.Event)
//   Called when the editor is focused.
//
//   onBlur:: ?(view: EditorView, event: dom.Event)
//   Called when the editor loses focus.
//
//   onUnmountDOM:: ?(view: EditorView, dom.Node)
//   Called when a display update throws away a DOM node that was part
//   of the previous document view. Can be useful when your node
//   representations need to be cleaned up somehow. Note that this is
//   only called with the top of the unmounted tree, not with every
//   node in it.
//
//   domParser:: ?DOMParser
//   The [parser](#model.DOMParser) to use when reading editor changes
//   from the DOM. Defaults to calling
//   [`DOMParser.fromSchema`](#model.DOMParser^fromSchema) on the
//   editor's schema.
//
//   clipboardParser:: ?DOMParser
//   The [parser](#model.DOMParser) to use when reading content from
//   the clipboard. When not given, the value of the
//   [`domParser`](#view.EditorProps.domParser) prop is used.
//
//   transformPasted:: ?(Slice) → Slice
//   Can be used to transform pasted content before it is applied to
//   the document.
//
//   domSerializer:: ?DOMSerializer
//   The [serializer](#model.DOMSerializer) to use when drawing the
//   document to the display. If not given, the result of
//   [`DOMSerializer.fromSchema`](#model.DOMSerializer^fromSchema)
//   will be used.
//
//   nodeViews:: ?Object<(node: Node, sendAction: (state: EditorState, pos: number) → ?Action) → NodeView>
//   Use the given [node view](#view.NodeView) implementation to
//   manage the DOM representation of certain node types. When a node
//   view is created, it is passed an action-sending function that it
//   can use to find out its current position in the document and the
//   current editor state, and optionally produce an
//   [action](#state.Action) to send to the editor's
//   [`onAction`](#view.EditorProps.onAction) callback.
//
//   clipboardSerializer:: ?DOMSerializer
//   The DOM serializer to use when putting content onto the
//   clipboard. When not given, the value of the
//   [`domSerializer`](#view.EditorProps.domSerializer) prop is used.
//
//   decorations:: ?DecorationSet
//   A set of [document decorations](#view.Decoration) to add to the
//   view.
//
//   spellcheck:: ?bool
//   Controls whether the DOM spellcheck attribute is enabled on the
//   editable content. Defaults to false.
//
//   class:: ?(state: EditorState) → ?string
//   Controls the CSS class name of the editor DOM node. Any classes
//   returned from this will be added to the default `ProseMirror`
//   class.
//
//   label:: ?(state: EditorState) → ?string
//   Can be used to set an `aria-label` attribute on the editable
//   content node.
//
//   scrollThreshold:: ?number
//   Determines the distance (in pixels) between the cursor and the
//   end of the visible viewport at which point, when scrolling the
//   cursor into view, scrolling takes place. Defaults to 0.
//
//   scrollMargin:: ?number
//   Determines the extra space (in pixels) that is left above or
//   below the cursor when it is scrolled into view. Defaults to 5.

// NodeView:: interface
//
// A node view is an object that acts as an intermediary between an
// editor view and the DOM representation of a certain node. An
// instance is created when the node is drawn, and it can handle
// certain aspects of the DOM behavior for the node.
//
//   dom:: dom.Node
//   The DOM node that should be used as the node's representation.
//
//   contentDOM:: ?dom.Node
//   The DOM node that holds the node's child nodes. Defaults to the
//   main `dom` property. Only relevant for non-leaf node types.
//
//   parseRule:: ?() → ParseRule
//   Can be used by the view to control the parsing of the DOM.
//
//   update:: ?(newNode: Node) → bool
//   An optional method that the redraw algorithm will use to update
//   the view when the node or its content changes. When present, it
//   will be called when a DOM update finds a changed node of the same
//   type in the place of the view's node. When it returns true, it
//   should have updated the DOM structure to show the changed node.
//   It may return false to indicate that it can't update, and a
//   redraw should happen.
//
//   select:: ?()
//   When present, this will be called when the node is selected as a
//   node selection. It replaces the default selected-node styling.
//
//   deselect:: ?()
//   When present, and `select` is also present, this will be called
//   when the node stops being selected. It should remove any styling
//   that `select` added.

const {DOMSerializer} = require("prosemirror-model")

const browser = require("./browser")
const {childContainer, posBeforeFromDOM} = require("./dompos")

function getSerializer(view) {
  let serializer = view.someProp("domSerializer") || DOMSerializer.fromSchema(view.state.schema), copied
  view.someProp("nodeViews", views => {
    if (!copied) {
      copied = {}
      for (let name in serializer.nodes) copied[name] = serializer.nodes[name]
      serializer = new DOMSerializer(copied, serializer.marks)
    }
    for (let name in views) copied[name] = nodeViewConstructor(view, views[name], copied[name])
  })
  return serializer
}

function nodeViewConstructor(view, nodeView, old) {
  return node => {
    let viewObj = nodeView(node, getAction => {
      let action = viewObj && getAction(view.state, posBeforeFromDOM(viewObj.dom))
      if (action) view.props.onAction(action)
    })
    if (!viewObj) return old(node)
    viewObj.dom.pmNodeView = viewObj
    if (!node.isLeaf) (viewObj.contentDOM || viewObj.dom).setAttribute("pm-container", true)
    return viewObj.dom
  }
}

function draw(view, doc, decorations) {
  view.content.textContent = ""
  new Context(getSerializer(view), decorations).serializeContent(doc, view.content)
}
exports.draw = draw

function redraw(view, oldDoc, newDoc, oldDecorations, newDecorations) {
  let serializer = getSerializer(view)
  let onUnmountDOM = []
  view.someProp("onUnmountDOM", f => { onUnmountDOM.push(f) })

  function scan(dom, node, prev, oldDecorations, newDecorations) {
    let iPrev = 0, oPrev = 0, pChild = prev.firstChild
    let domPos = dom.firstChild
    while (domPos && (domPos.nodeType != 1 || domPos.hasAttribute("pm-ignore")))
      domPos = movePast(domPos, view, onUnmountDOM)

    let localDecorations = newDecorations.locals(node)
    let decoIndex = applyDecorations(localDecorations, 0, 0, 0, dom, domPos, false)

    function syncDOM() {
      while (domPos) {
        let curOff = domPos.nodeType == 1 && domPos.getAttribute("pm-offset")
        if (!curOff || +curOff < oPrev)
          domPos = movePast(domPos, view, onUnmountDOM)
        else
          return +curOff == oPrev
      }
      return false
    }
    let oldLocalDecorations, offset = 0, child
    function sameLocalDeco() {
      return compareDecorations(oldLocalDecorations || (oldLocalDecorations = oldDecorations.locals(prev)),
                                localDecorations, decoIndex,
                                oPrev, oPrev + pChild.nodeSize, offset, offset + child.nodeSize)
    }

    for (let iNode = 0; iNode < node.childCount; iNode++) {
      let matching, reuseDOM
      child = node.child(iNode)
      let found = pChild == child ? iPrev : findNodeIn(prev, iPrev + 1, child)
      if (found > -1) {
        matching = child
        while (iPrev != found) {
          oPrev += pChild.nodeSize
          pChild = prev.maybeChild(++iPrev)
        }
      }

      let childDeco = newDecorations.forChild(offset, child), prevChildDeco, matchedLocalDeco, nodeView
      if (matching &&
          childDeco.sameOutput(prevChildDeco = oldDecorations.forChild(offset, child)) &&
          (matchedLocalDeco = sameLocalDeco()) != null &&
          syncDOM()) {
        reuseDOM = true
        decoIndex = matchedLocalDeco
      } else if (pChild && !child.isText && child.type == pChild.type &&
                 (matchedLocalDeco = sameLocalDeco()) != null && syncDOM() &&
                 ((nodeView = domPos.pmNodeView) && nodeView.update ? nodeView.update(child) : child.sameMarkup(pChild))) {
        reuseDOM = true
        decoIndex = matchedLocalDeco
        if (!pChild.isLeaf)
          scan(childContainer(domPos), child, pChild, prevChildDeco || oldDecorations.forChild(oPrev, pChild), childDeco)
        domPos.setAttribute("pm-size", child.nodeSize)
      } else {
        let rendered = new Context(serializer, childDeco).serialize(child, offset)
        dom.insertBefore(rendered, domPos)
        reuseDOM = false
        decoIndex = applyDecorations(localDecorations, decoIndex, offset, offset + child.nodeSize, dom, rendered)
      }

      if (reuseDOM) {
        // Text nodes might be split into smaller segments
        if (child.isText) {
          for (let off = offset, end = off + child.nodeSize; off < end;) {
            if (offset != oPrev)
              domPos.setAttribute("pm-offset", off)
            off += +domPos.getAttribute("pm-size")
            domPos = domPos.nextSibling
          }
        } else {
          if (offset != oPrev)
            domPos.setAttribute("pm-offset", offset)
          domPos = domPos.nextSibling
        }
        oPrev += pChild.nodeSize
        pChild = prev.maybeChild(++iPrev)
        let end = offset + child.nodeSize
        decoIndex = applyDecorations(localDecorations, decoIndex, end, end, dom, domPos)
      }
      offset += child.nodeSize
    }

    while (domPos) domPos = movePast(domPos, view, onUnmountDOM)

    if (node.isTextblock) adjustTrailingHacks(serializer, dom, node)

    if (browser.ios) iosHacks(dom)
  }
  scan(view.content, newDoc, oldDoc, oldDecorations, newDecorations)
}
exports.redraw = redraw

class Context {
  constructor(serializer, decorations) {
    this.serializer = serializer
    this.decorations = decorations
  }

  onContent(parent, target) {
    target.setAttribute("pm-container", true)
    this.serializeContent(parent, target, this.decorations)
  }

  serialize(node, offset) {
    let dom = this.serializer.serializeNodeAndMarks(node, this)
    if (dom.nodeType != 1 || dom.contentEditable == "false") {
      let wrap = document.createElement(node.isInline ? "span" : "div")
      wrap.appendChild(dom)
      dom = wrap
    }
    dom.setAttribute("pm-size", node.nodeSize)
    dom.setAttribute("pm-offset", offset)
    if (node.isTextblock) adjustTrailingHacks(this.serializer, dom, node)
    return dom
  }

  serializeContent(node, target) {
    let decorations = this.decorations
    let locals = decorations.locals(node)
    let i = applyDecorations(locals, 0, 0, 0, target, null, false)
    node.content.forEach((child, offset) => {
      this.decorations = decorations.forChild(offset, child)
      let dom = target.appendChild(this.serialize(child, offset))
      i = applyDecorations(locals, i, offset, offset + child.nodeSize, target, dom)
    })
  }
}

// : ([Decoration], number, number, number, dom.Node, ?dom.Node) → number
// Used to apply decorations, either at a given point in a node that's
// being updated, or those in and after a given child node. `i` is an
// index into the local set of (non-overlapping) decorations, which is
// used to avoid scanning through the array multiple times.
//
// When `from` == `to`, this should only draw inserted decorations at
// the given position. When `from` < `to`, this should also decorate a
// node. That node may be a text node, which may have different
// decorations at different points, in which case it has to be split.
//
// `domNode` should be _the node after `from`_. That means that it is
// the current node when `from` < `to`, and the node after the current
// position when they are equal. It may be null, when `from` == `to`
// and there are no nodes after the current point.
//
// Returns the updated index, which can be passed back to this
// function later.
function applyDecorations(locals, i, from, to, domParent, domNode) {
  let result = i
  for (; i < locals.length; i++) {
    let span = locals[i]
    if (span.from > to || (span.from == to && span.to > to)) break
    if (from < span.from) {
      domNode = span.from < to ? splitText(domNode, span.from - from) : domNode.nextSibling
      from = span.from
    }
    let curNode = domNode
    if (span.to < to && span.from < span.to) {
      domNode = splitText(domNode, span.to - from)
      from = span.to
    }

    for (;;) {
      curNode = span.type.apply(domParent, curNode)
      if (i < locals.length - 1 && locals[i + 1].to == span.to && locals[i + 1].from == span.from) span = locals[++i]
      else break
    }
    if (span.to <= to) result = i + 1
  }
  return result
}

function compareDecorations(old, cur, i, oldFrom, oldTo, curFrom, curTo) {
  let j = 0, result = i
  while (j < old.length && old[j].to <= oldFrom) j++
  for (;; i++, j++) {
    let oldEnd = j == old.length || old[j].from >= oldTo
    if (i == cur.length || cur[i].from >= curTo) return oldEnd ? result : null
    else if (oldEnd) return null
    let oldNext = old[j], curNext = cur[i]
    if (oldNext.type != curNext.type ||
        oldNext.from - oldFrom != curNext.from - curFrom ||
        oldNext.to - oldFrom != curNext.to - curFrom) return null
    if (curNext.to <= curTo) result = i + 1
  }
}

function splitText(node, offset) {
  let inner = node
  while (inner.nodeType != 3) inner = inner.firstChild
  let newNode = document.createTextNode(inner.nodeValue.slice(offset))
  inner.nodeValue = inner.nodeValue.slice(0, offset)
  while (inner != node) {
    let parent = inner.parentNode, wrap = parent.cloneNode(false)
    wrap.appendChild(newNode)
    newNode = wrap
    inner = parent
  }
  node.parentNode.insertBefore(newNode, node.nextSibling)
  let size = +node.getAttribute("pm-size")
  newNode.setAttribute("pm-size", size - offset)
  node.setAttribute("pm-size", offset)
  newNode.setAttribute("pm-offset", +node.getAttribute("pm-offset") + offset)
  return newNode
}

function findNodeIn(parent, i, node) {
  for (; i < parent.childCount; i++) {
    let child = parent.child(i)
    if (child == node) return i
  }
  return -1
}

function movePast(dom, view, onUnmount) {
  let next = dom.nextSibling
  for (let i = 0; i < onUnmount.length; i++) onUnmount[i](view, dom)
  dom.parentNode.removeChild(dom)
  return next
}

function isBR(node, serializer) {
  if (!node.isLeaf || node.isText || !node.isInline) return false
  let ser = serializer.nodes[node.type.name](node)
  return Array.isArray(ser) ? ser[0] == "br" : ser && ser.nodeName == "BR"
}

function adjustTrailingHacks(serializer, dom, node) {
  let needs = node.content.size == 0 || isBR(node.lastChild, serializer) ||
      (node.type.spec.code && node.lastChild.isText && /\n$/.test(node.lastChild.text))
      ? "br" : !node.lastChild.isText && node.lastChild.isLeaf ? "text" : null
  let last = dom.lastChild
  let has = !last || last.nodeType != 1 || !last.hasAttribute("pm-ignore") ? null
      : last.nodeName == "BR" ? "br" : "text"
  if (needs != has) {
    if (has == "br") dom.removeChild(last)
    if (needs) {
      let add = document.createElement(needs == "br" ? "br" : "span")
      add.setAttribute("pm-ignore", needs == "br" ? "trailing-break" : "cursor-text")
      dom.appendChild(add)
    }
  }
}

function iosHacks(dom) {
  if (dom.nodeName == "UL" || dom.nodeName == "OL") {
    let oldCSS = dom.style.cssText
    dom.style.cssText = oldCSS + "; list-style: square !important"
    window.getComputedStyle(dom).listStyle
    dom.style.cssText = oldCSS
  }
}

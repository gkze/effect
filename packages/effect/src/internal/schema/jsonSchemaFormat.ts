// RFC 3986 URI components, RFC 3339 full-date, and ASCII mailbox syntax.
// Format validation is opt-in at the JSON Schema import boundary.
const pathCharacters = /^(?:[a-z0-9\-._~!$&'()*+,;=:@/]|%[0-9a-f]{2})*$/i
const queryCharacters = /^(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*$/i
const registeredName = /^(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*$/i
const userInfo = /^(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*$/i
const futureIp = /^v[0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+$/i

function uri(value: string): boolean {
  // Component expressions use $, so reject line terminators before matching.
  if (/[\r\n]/.test(value)) return false
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(value)
  if (scheme === null) return false
  let rest = value.slice(scheme[0].length)
  const hash = rest.indexOf("#")
  if (hash !== -1) {
    if (!queryCharacters.test(rest.slice(hash + 1))) return false
    rest = rest.slice(0, hash)
  }
  const query = rest.indexOf("?")
  if (query !== -1) {
    if (!queryCharacters.test(rest.slice(query + 1))) return false
    rest = rest.slice(0, query)
  }
  if (!rest.startsWith("//")) return pathCharacters.test(rest)
  const slash = rest.indexOf("/", 2)
  let authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash)
  if (slash !== -1 && !pathCharacters.test(rest.slice(slash))) return false
  const at = authority.lastIndexOf("@")
  if (at !== -1) {
    if (!userInfo.test(authority.slice(0, at))) return false
    authority = authority.slice(at + 1)
  }
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]")
    if (end === -1 || !/^(?::[0-9]*)?$/.test(authority.slice(end + 1))) return false
    const host = authority.slice(1, end)
    return futureIp.test(host) || host.includes(":") && URL.canParse(`http://[${host}]/`)
  }
  const colon = authority.indexOf(":")
  return colon === -1 ?
    registeredName.test(authority) :
    registeredName.test(authority.slice(0, colon)) && /^[0-9]*$/.test(authority.slice(colon + 1))
}

function email(value: string): boolean {
  if (/[\r\n]/.test(value)) return false
  const parts = value.split("@")
  if (parts.length !== 2) return false
  const domain = parts[1].split(".")
  return parts[0].split(".").every((part) => /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+$/i.test(part)) &&
    domain.length > 1 && domain.every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part))
}

function date(value: string): boolean {
  if (value.length !== 10 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8))
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? leap ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31
  return month >= 1 && month <= 12 && day >= 1 && day <= days
}

function regex(value: string): boolean {
  try {
    return new globalThis.RegExp(value) instanceof globalThis.RegExp
  } catch {
    return false
  }
}

/** @internal */
export const formats = { uri, email, date, regex }

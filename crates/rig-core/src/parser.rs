use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UnaryOp {
    Neg,
    Pos,
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Less,
    LessEq,
    Greater,
    GreaterEq,
    Eq,
    NotEq,
    And,
    Or,
}

#[derive(Debug, Clone)]
pub enum Expr {
    Number(f64),
    Name(String),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ternary {
        condition: Box<Expr>,
        yes: Box<Expr>,
        no: Box<Expr>,
    },
    Member {
        expr: Box<Expr>,
        name: String,
    },
    Call {
        id: u32,
        name: String,
        args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Number(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    LParen,
    RParen,
    Comma,
    Dot,
    Question,
    Colon,
    Less,
    LessEq,
    Greater,
    GreaterEq,
    EqEq,
    NotEq,
    And,
    Or,
    Not,
    End,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    position: usize,
}

fn lex(source: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        let kind = match c {
            '+' => {
                i += 1;
                TokenKind::Plus
            }
            '-' => {
                i += 1;
                TokenKind::Minus
            }
            '*' => {
                i += 1;
                TokenKind::Star
            }
            '/' => {
                i += 1;
                TokenKind::Slash
            }
            '%' => {
                i += 1;
                TokenKind::Percent
            }
            '^' => {
                i += 1;
                TokenKind::Caret
            }
            '(' => {
                i += 1;
                TokenKind::LParen
            }
            ')' => {
                i += 1;
                TokenKind::RParen
            }
            ',' => {
                i += 1;
                TokenKind::Comma
            }
            '?' => {
                i += 1;
                TokenKind::Question
            }
            ':' => {
                i += 1;
                TokenKind::Colon
            }
            '<' => {
                i += 1;
                if i < chars.len() && chars[i] == '=' {
                    i += 1;
                    TokenKind::LessEq
                } else {
                    TokenKind::Less
                }
            }
            '>' => {
                i += 1;
                if i < chars.len() && chars[i] == '=' {
                    i += 1;
                    TokenKind::GreaterEq
                } else {
                    TokenKind::Greater
                }
            }
            '=' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    i += 2;
                    TokenKind::EqEq
                } else {
                    return Err(format!("неожиданный '=' на позиции {}", i + 1));
                }
            }
            '!' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    i += 2;
                    TokenKind::NotEq
                } else {
                    return Err(format!("ожидалось '!=' на позиции {}", i + 1));
                }
            }
            '.' if i + 1 < chars.len() && chars[i + 1].is_ascii_digit() => {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i < chars.len() && chars[i] == 'e' || i < chars.len() && chars[i] == 'E' {
                    return Err("экспоненциальная запись после '.5' пока не поддерживается".into());
                }
                let value: String = chars[start..i].iter().collect();
                TokenKind::Number(value.parse().map_err(|_| "некорректное число")?)
            }
            '.' => {
                i += 1;
                TokenKind::Dot
            }
            '0'..='9' => {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i < chars.len() && chars[i] == '.' {
                    i += 1;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                    i += 1;
                    if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                        i += 1;
                    }
                    let exponent_start = i;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                    if exponent_start == i {
                        return Err(format!("некорректная экспонента на позиции {}", start + 1));
                    }
                }
                let value: String = chars[start..i].iter().collect();
                TokenKind::Number(value.parse().map_err(|_| "некорректное число")?)
            }
            'a'..='z' | 'A'..='Z' | '_' => {
                i += 1;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let ident: String = chars[start..i].iter().collect();
                match ident.as_str() {
                    "and" => TokenKind::And,
                    "or" => TokenKind::Or,
                    "not" => TokenKind::Not,
                    _ => TokenKind::Ident(ident),
                }
            }
            _ => return Err(format!("неизвестный символ '{}' на позиции {}", c, i + 1)),
        };
        tokens.push(Token {
            kind,
            position: start,
        });
    }
    tokens.push(Token {
        kind: TokenKind::End,
        position: source.len(),
    });
    Ok(tokens)
}

struct ExpressionParser {
    tokens: Vec<Token>,
    current: usize,
    call_id: u32,
}

impl ExpressionParser {
    fn new(source: &str) -> Result<Self, String> {
        Ok(Self {
            tokens: lex(source)?,
            current: 0,
            call_id: 0,
        })
    }

    fn parse(mut self) -> Result<Expr, String> {
        let expr = self.ternary()?;
        if self.peek() != &TokenKind::End {
            return Err(format!(
                "неожиданный токен на позиции {}",
                self.position() + 1
            ));
        }
        Ok(expr)
    }

    fn peek(&self) -> &TokenKind {
        &self.tokens[self.current].kind
    }
    fn position(&self) -> usize {
        self.tokens[self.current].position
    }
    fn advance(&mut self) -> TokenKind {
        let token = self.tokens[self.current].kind.clone();
        if self.current + 1 < self.tokens.len() {
            self.current += 1;
        }
        token
    }
    fn check(&self, expected: &TokenKind) -> bool {
        self.peek() == expected
    }
    fn consume(&mut self, expected: &TokenKind, message: &str) -> Result<(), String> {
        if self.check(expected) {
            self.advance();
            Ok(())
        } else {
            Err(format!("{} на позиции {}", message, self.position() + 1))
        }
    }

    fn ternary(&mut self) -> Result<Expr, String> {
        let mut expr = self.or()?;
        if self.check(&TokenKind::Question) {
            self.advance();
            let yes = self.ternary()?;
            self.consume(&TokenKind::Colon, "ожидалось ':'")?;
            let no = self.ternary()?;
            expr = Expr::Ternary {
                condition: Box::new(expr),
                yes: Box::new(yes),
                no: Box::new(no),
            };
        }
        Ok(expr)
    }

    fn or(&mut self) -> Result<Expr, String> {
        let mut expr = self.and()?;
        while self.check(&TokenKind::Or) {
            self.advance();
            expr = Expr::Binary {
                op: BinaryOp::Or,
                left: Box::new(expr),
                right: Box::new(self.and()?),
            };
        }
        Ok(expr)
    }

    fn and(&mut self) -> Result<Expr, String> {
        let mut expr = self.comparison()?;
        while self.check(&TokenKind::And) {
            self.advance();
            expr = Expr::Binary {
                op: BinaryOp::And,
                left: Box::new(expr),
                right: Box::new(self.comparison()?),
            };
        }
        Ok(expr)
    }

    fn comparison(&mut self) -> Result<Expr, String> {
        let mut expr = self.additive()?;
        loop {
            let op = match self.peek() {
                TokenKind::Less => BinaryOp::Less,
                TokenKind::LessEq => BinaryOp::LessEq,
                TokenKind::Greater => BinaryOp::Greater,
                TokenKind::GreaterEq => BinaryOp::GreaterEq,
                TokenKind::EqEq => BinaryOp::Eq,
                TokenKind::NotEq => BinaryOp::NotEq,
                _ => break,
            };
            self.advance();
            expr = Expr::Binary {
                op,
                left: Box::new(expr),
                right: Box::new(self.additive()?),
            };
        }
        Ok(expr)
    }

    fn additive(&mut self) -> Result<Expr, String> {
        let mut expr = self.multiplicative()?;
        loop {
            let op = match self.peek() {
                TokenKind::Plus => BinaryOp::Add,
                TokenKind::Minus => BinaryOp::Sub,
                _ => break,
            };
            self.advance();
            expr = Expr::Binary {
                op,
                left: Box::new(expr),
                right: Box::new(self.multiplicative()?),
            };
        }
        Ok(expr)
    }

    fn multiplicative(&mut self) -> Result<Expr, String> {
        let mut expr = self.unary()?;
        loop {
            let op = match self.peek() {
                TokenKind::Star => BinaryOp::Mul,
                TokenKind::Slash => BinaryOp::Div,
                TokenKind::Percent => BinaryOp::Mod,
                _ => break,
            };
            self.advance();
            expr = Expr::Binary {
                op,
                left: Box::new(expr),
                right: Box::new(self.unary()?),
            };
        }
        Ok(expr)
    }

    fn unary(&mut self) -> Result<Expr, String> {
        let op = match self.peek() {
            TokenKind::Minus => Some(UnaryOp::Neg),
            TokenKind::Plus => Some(UnaryOp::Pos),
            TokenKind::Not => Some(UnaryOp::Not),
            _ => None,
        };
        if let Some(op) = op {
            self.advance();
            return Ok(Expr::Unary {
                op,
                expr: Box::new(self.unary()?),
            });
        }
        self.power()
    }

    fn power(&mut self) -> Result<Expr, String> {
        let left = self.postfix()?;
        if self.check(&TokenKind::Caret) {
            self.advance();
            let right = self.unary()?;
            return Ok(Expr::Binary {
                op: BinaryOp::Pow,
                left: Box::new(left),
                right: Box::new(right),
            });
        }
        Ok(left)
    }

    fn postfix(&mut self) -> Result<Expr, String> {
        let mut expr = self.primary()?;
        loop {
            if self.check(&TokenKind::Dot) {
                self.advance();
                let name = match self.advance() {
                    TokenKind::Ident(name) => name,
                    _ => {
                        return Err(format!(
                            "ожидалось имя поля на позиции {}",
                            self.position() + 1
                        ))
                    }
                };
                expr = Expr::Member {
                    expr: Box::new(expr),
                    name,
                };
                continue;
            }
            if self.check(&TokenKind::LParen) {
                let name = match expr {
                    Expr::Name(name) => name,
                    _ => return Err("вызывать можно только встроенную функцию".into()),
                };
                self.advance();
                let mut args = Vec::new();
                if !self.check(&TokenKind::RParen) {
                    loop {
                        args.push(self.ternary()?);
                        if !self.check(&TokenKind::Comma) {
                            break;
                        }
                        self.advance();
                    }
                }
                self.consume(&TokenKind::RParen, "ожидалось ')'")?;
                let id = self.call_id;
                self.call_id += 1;
                expr = Expr::Call { id, name, args };
                continue;
            }
            break;
        }
        Ok(expr)
    }

    fn primary(&mut self) -> Result<Expr, String> {
        match self.advance() {
            TokenKind::Number(value) => Ok(Expr::Number(value)),
            TokenKind::Ident(name) => Ok(Expr::Name(name)),
            TokenKind::LParen => {
                let expr = self.ternary()?;
                self.consume(&TokenKind::RParen, "ожидалось ')'")?;
                Ok(expr)
            }
            _ => Err(format!(
                "ожидалось выражение на позиции {}",
                self.position() + 1
            )),
        }
    }
}

pub fn parse_expression(source: &str) -> Result<Expr, String> {
    ExpressionParser::new(source)?.parse()
}

pub fn parse_script(source: &str) -> Result<Vec<(String, Arc<Expr>)>, String> {
    let mut result = Vec::new();
    let mut next_call_id = 0u32;
    for (index, raw_line) in source.lines().enumerate() {
        let line = raw_line.split("//").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let (name, expression) = line.split_once('=').ok_or_else(|| {
            format!(
                "строка {}: ожидалось присваивание 'имя = выражение'",
                index + 1
            )
        })?;
        let name = name.trim();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!(
                "строка {}: некорректное имя '{}'; ожидался ASCII-идентификатор",
                index + 1,
                name
            ));
        }
        if result.iter().any(|(existing, _)| existing == name) {
            return Err(format!(
                "строка {}: параметр '{}' присваивается дважды",
                index + 1,
                name
            ));
        }
        let expr = parse_expression(expression.trim())
            .map_err(|error| format!("строка {}: {}", index + 1, error))?;
        // IDs are unique within one script. They are scoped by node in the runtime.
        let mut counter = CountCalls(next_call_id);
        counter.visit(&expr);
        next_call_id = counter.0;
        result.push((name.to_string(), Arc::new(expr)));
    }
    Ok(result)
}

struct CountCalls(u32);
impl CountCalls {
    fn visit(&mut self, expr: &Expr) {
        match expr {
            Expr::Call { id, args, .. } => {
                self.0 = self.0.max(*id + 1);
                for arg in args {
                    self.visit(arg);
                }
            }
            Expr::Unary { expr, .. } => self.visit(expr),
            Expr::Binary { left, right, .. } => {
                self.visit(left);
                self.visit(right);
            }
            Expr::Ternary { condition, yes, no } => {
                self.visit(condition);
                self.visit(yes);
                self.visit(no);
            }
            Expr::Member { expr, .. } => self.visit(expr),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn power_is_right_associative() {
        let expr = parse_expression("2 ^ 3 ^ 2").unwrap();
        match expr {
            Expr::Binary {
                op: BinaryOp::Pow,
                right,
                ..
            } => {
                assert!(matches!(
                    *right,
                    Expr::Binary {
                        op: BinaryOp::Pow,
                        ..
                    }
                ));
            }
            _ => panic!("expected power"),
        }
    }

    #[test]
    fn comments_and_vector_members_parse() {
        let script =
            parse_script("x = follow(offset, parent).x // movement\ny = vec(1, 2).y").unwrap();
        assert_eq!(script.len(), 2);
    }

    #[test]
    fn duplicate_assignment_is_rejected() {
        assert!(parse_script("x = 1\nx = 2").is_err());
    }
}
